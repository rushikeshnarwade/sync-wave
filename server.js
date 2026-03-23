const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 5000,
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Upload Setup ──────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const storage = multer.diskStorage({
  destination: (req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname);
    cb(null, `${id}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
});

// Serve uploaded files
app.use('/media', express.static(UPLOADS_DIR));

// Upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const fileUrl = `/media/${req.file.filename}`;
  const fileId = path.parse(req.file.filename).name;
  res.json({
    id: fileId,
    url: fileUrl,
    name: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype,
  });
});

// ── Room State ────────────────────────────────────────────────────────
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createRoom(hostId, hostName) {
  let code;
  do { code = generateRoomCode(); } while (rooms.has(code));

  const room = {
    code,
    hostId,
    users: new Map(),
    media: null,        // { type: 'youtube'|'file', url, title }
    readyUsers: new Set(),
    playback: {
      playing: false,
      position: 0,       // seconds
      lastSyncTime: null, // server timestamp of last state change
    },
    createdAt: Date.now(),
  };
  room.users.set(hostId, { id: hostId, name: hostName, isHost: true });
  rooms.set(code, room);
  return room;
}

function getExpectedPosition(room) {
  const pb = room.playback;
  if (!pb.playing || !pb.lastSyncTime) return pb.position;
  const elapsed = (Date.now() - pb.lastSyncTime) / 1000;
  return pb.position + elapsed;
}

// Clean up stale rooms every 30 min
setInterval(() => {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (Date.now() - room.createdAt > TWO_HOURS && room.users.size === 0) {
      rooms.delete(code);
    }
  }
}, 30 * 60 * 1000);

// Clean up old uploads every hour
setInterval(() => {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  fs.readdir(UPLOADS_DIR, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join(UPLOADS_DIR, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        if (Date.now() - stats.mtimeMs > TWO_HOURS) {
          fs.unlink(filePath, () => {});
        }
      });
    });
  });
}, 60 * 60 * 1000);

// ── Socket.IO ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoom = null;
  let userId = null;

  // ─ Clock Sync (NTP-style) ─
  socket.on('clock-sync', (data, callback) => {
    // Client sends { t0 }, server responds with { t0, t1 }
    callback({ t0: data.t0, t1: Date.now() });
  });

  // ─ Create Room ─
  socket.on('create-room', ({ userName }, callback) => {
    userId = socket.id;
    const room = createRoom(userId, userName);
    currentRoom = room.code;
    socket.join(room.code);
    callback({
      success: true,
      roomCode: room.code,
      users: Array.from(room.users.values()),
      isHost: true,
    });
  });

  // ─ Join Room ─
  socket.on('join-room', ({ roomCode, userName }, callback) => {
    const code = roomCode.toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) return callback({ success: false, error: 'Room not found' });
    if (room.users.size >= 5) return callback({ success: false, error: 'Room is full (max 5)' });

    userId = socket.id;
    currentRoom = code;
    room.users.set(userId, { id: userId, name: userName, isHost: false });
    socket.join(code);

    // Tell the new user the current state
    callback({
      success: true,
      roomCode: code,
      users: Array.from(room.users.values()),
      isHost: false,
      media: room.media,
      playback: {
        playing: room.playback.playing,
        position: getExpectedPosition(room),
      },
    });

    // Tell everyone else
    socket.to(code).emit('user-joined', {
      user: room.users.get(userId),
      users: Array.from(room.users.values()),
    });
  });

  // ─ Load Media ─
  socket.on('load-media', ({ type, url, title }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== userId) return;

    room.media = { type, url, title };
    room.readyUsers.clear();
    room.playback = { playing: false, position: 0, lastSyncTime: null };

    io.to(currentRoom).emit('media-loaded', {
      media: room.media,
      playback: room.playback,
    });
  });

  // ─ Media Ready (Buffering completely) ─
  socket.on('media-ready', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || !room.media) return;

    room.readyUsers.add(userId);
    // If all users in the room have buffered, tell them they can play
    if (room.readyUsers.size === room.users.size) {
      io.to(currentRoom).emit('all-ready');
    }
  });

  // ─ Play ─
  socket.on('play', ({ position }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== userId) return;

    const executeAt = Date.now() + 800; // 800ms in the future
    room.playback.playing = true;
    room.playback.position = position != null ? position : getExpectedPosition(room);
    room.playback.lastSyncTime = executeAt;

    io.to(currentRoom).emit('sync-play', {
      position: room.playback.position,
      executeAt,
    });
  });

  // ─ Pause ─
  socket.on('pause', ({ position }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== userId) return;

    room.playback.playing = false;
    room.playback.position = position != null ? position : getExpectedPosition(room);
    room.playback.lastSyncTime = Date.now();

    const executeAt = Date.now() + 800;
    io.to(currentRoom).emit('sync-pause', {
      position: room.playback.position,
      executeAt,
    });
  });

  // ─ Seek ─
  socket.on('seek', ({ position }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== userId) return;

    room.playback.position = position;
    room.playback.lastSyncTime = Date.now();

    const executeAt = Date.now() + 800;
    io.to(currentRoom).emit('sync-seek', {
      position,
      executeAt,
      playing: room.playback.playing,
    });
  });

  // ─ Heartbeat (drift detection) ─
  socket.on('heartbeat', ({ position }) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || !room.playback.playing) return;

    const expected = getExpectedPosition(room);
    const drift = position - expected;

    // Send correction if drift > 50ms, else send sync-ok to reset playback rate
    if (Math.abs(drift) > 0.05) {
      socket.emit('drift-correction', {
        expectedPosition: expected,
        drift,
      });
    } else {
      socket.emit('sync-ok');
    }
  });

  // ─ Disconnect ─
  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    room.users.delete(userId);

    if (room.users.size === 0) {
      // Keep room alive for 5 min in case of reconnect
      setTimeout(() => {
        const r = rooms.get(currentRoom);
        if (r && r.users.size === 0) rooms.delete(currentRoom);
      }, 5 * 60 * 1000);
      return;
    }

    // Host transfer
    if (room.hostId === userId) {
      const newHost = room.users.values().next().value;
      newHost.isHost = true;
      room.hostId = newHost.id;
      io.to(currentRoom).emit('host-changed', { newHostId: newHost.id });
    }

    io.to(currentRoom).emit('user-left', {
      userId,
      users: Array.from(room.users.values()),
    });
  });
});

// ── Start ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎵 Sync Player running on http://localhost:${PORT}`);
});
