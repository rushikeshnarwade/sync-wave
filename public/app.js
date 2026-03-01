/* ── SyncWave Client ───────────────────────────────────────────────── */
(() => {
    'use strict';

    // ── State ─────────────────────────────────────────────────────────
    const state = {
        socket: null,
        roomCode: null,
        userId: null,
        userName: null,
        isHost: false,
        users: [],
        media: null,         // { type, url, title }
        clockOffset: 0,      // ms: serverTime = Date.now() + clockOffset
        ytPlayer: null,
        ytReady: false,
        html5Player: null,   // <video> or <audio> element
        activePlayerType: null, // 'youtube' | 'video' | 'audio'
        isPlaying: false,
        duration: 0,
        suppressEvents: false,
        heartbeatInterval: null,
        progressInterval: null,
    };

    // ── DOM ───────────────────────────────────────────────────────────
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const dom = {
        landingScreen: $('#landing-screen'),
        playerScreen: $('#player-screen'),
        createName: $('#create-name'),
        createBtn: $('#create-btn'),
        joinCode: $('#join-code'),
        joinName: $('#join-name'),
        joinBtn: $('#join-btn'),
        landingError: $('#landing-error'),
        roomCodeDisplay: $('#room-code-display'),
        copyRoomBtn: $('#copy-room-btn'),
        userCount: $('#user-count'),
        leaveBtn: $('#leave-btn'),
        mediaContainer: $('#media-container'),
        mediaPlaceholder: $('#media-placeholder'),
        placeholderHint: $('#placeholder-hint'),
        youtubeContainer: $('#youtube-container'),
        html5Player: $('#html5-player'),
        audioPlayer: $('#audio-player'),
        progressContainer: $('#progress-container'),
        progressBar: $('#progress-bar'),
        progressFill: $('#progress-fill'),
        progressThumb: $('#progress-thumb'),
        timeCurrent: $('#time-current'),
        timeDuration: $('#time-duration'),
        controls: $('#controls'),
        btnPlay: $('#btn-play'),
        playIcon: $('#play-icon'),
        pauseIcon: $('#pause-icon'),
        btnRewind: $('#btn-rewind'),
        btnForward: $('#btn-forward'),
        btnVolume: $('#btn-volume'),
        volIcon: $('#vol-icon'),
        muteIcon: $('#mute-icon'),
        volumeSlider: $('#volume-slider'),
        mediaPanel: $('#media-panel'),
        youtubeUrl: $('#youtube-url'),
        loadYoutubeBtn: $('#load-youtube-btn'),
        fileInput: $('#file-input'),
        fileUploadLabel: $('#file-upload-label'),
        uploadProgress: $('#upload-progress'),
        uploadFill: $('#upload-fill'),
        uploadText: $('#upload-text'),
        nowPlayingPanel: $('#now-playing-panel'),
        nowPlayingTitle: $('#now-playing-title'),
        syncStatus: $('#sync-status'),
        userList: $('#user-list'),
        toastContainer: $('#toast-container'),
    };

    // ── Utilities ─────────────────────────────────────────────────────
    function serverNow() {
        return Date.now() + state.clockOffset;
    }

    function formatTime(s) {
        if (!isFinite(s) || s < 0) s = 0;
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${sec.toString().padStart(2, '0')}`;
    }

    function toast(msg, type = 'info') {
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.textContent = msg;
        dom.toastContainer.appendChild(el);
        setTimeout(() => el.remove(), 3500);
    }

    function extractYoutubeId(url) {
        const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        return m ? m[1] : null;
    }

    function showScreen(name) {
        $$('.screen').forEach(s => s.classList.remove('active'));
        $(`#${name}-screen`).classList.add('active');
    }

    function updateHostUI() {
        if (state.isHost) {
            dom.mediaPanel.classList.remove('host-only-disabled');
            dom.placeholderHint.textContent = "You're the host — load something below!";
        } else {
            dom.mediaPanel.classList.add('host-only-disabled');
            dom.placeholderHint.textContent = 'Waiting for host to load media...';
        }
    }

    // ── Clock Sync (NTP-style) ────────────────────────────────────────
    async function performClockSync() {
        const offsets = [];
        for (let i = 0; i < 5; i++) {
            const offset = await singleClockSync();
            if (offset !== null) offsets.push(offset);
            await sleep(50);
        }
        if (offsets.length > 0) {
            offsets.sort((a, b) => a - b);
            // Use median
            state.clockOffset = offsets[Math.floor(offsets.length / 2)];
        }
    }

    function singleClockSync() {
        return new Promise((resolve) => {
            const t0 = Date.now();
            state.socket.emit('clock-sync', { t0 }, (response) => {
                const t3 = Date.now();
                const { t1 } = response;
                // NTP offset formula: offset = t1 - (t0 + t3)/2
                const offset = t1 - (t0 + t3) / 2;
                resolve(offset);
            });
            // timeout
            setTimeout(() => resolve(null), 2000);
        });
    }

    function sleep(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // ── Unified Player Interface ──────────────────────────────────────
    function getActivePlayer() {
        if (state.activePlayerType === 'youtube') return state.ytPlayer;
        return state.html5Player;
    }

    function playerGetCurrentTime() {
        if (state.activePlayerType === 'youtube' && state.ytPlayer) {
            return state.ytPlayer.getCurrentTime() || 0;
        }
        if (state.html5Player) return state.html5Player.currentTime || 0;
        return 0;
    }

    function playerGetDuration() {
        if (state.activePlayerType === 'youtube' && state.ytPlayer) {
            return state.ytPlayer.getDuration() || 0;
        }
        if (state.html5Player) return state.html5Player.duration || 0;
        return 0;
    }

    function playerPlay() {
        state.suppressEvents = true;
        if (state.activePlayerType === 'youtube' && state.ytPlayer) {
            state.ytPlayer.playVideo();
        } else if (state.html5Player) {
            state.html5Player.play().catch(() => { });
        }
        state.isPlaying = true;
        updatePlayButton();
        updateAudioBars();
        setTimeout(() => { state.suppressEvents = false; }, 500);
    }

    function playerPause() {
        state.suppressEvents = true;
        if (state.activePlayerType === 'youtube' && state.ytPlayer) {
            state.ytPlayer.pauseVideo();
        } else if (state.html5Player) {
            state.html5Player.pause();
        }
        state.isPlaying = false;
        updatePlayButton();
        updateAudioBars();
        setTimeout(() => { state.suppressEvents = false; }, 500);
    }

    function playerSeek(seconds) {
        state.suppressEvents = true;
        if (state.activePlayerType === 'youtube' && state.ytPlayer) {
            state.ytPlayer.seekTo(seconds, true);
        } else if (state.html5Player) {
            state.html5Player.currentTime = seconds;
        }
        setTimeout(() => { state.suppressEvents = false; }, 500);
    }

    function playerSetVolume(vol) {
        // vol 0-100
        if (state.activePlayerType === 'youtube' && state.ytPlayer) {
            state.ytPlayer.setVolume(vol);
        } else if (state.html5Player) {
            state.html5Player.volume = vol / 100;
        }
    }

    function playerIsMuted() {
        if (state.activePlayerType === 'youtube' && state.ytPlayer) return state.ytPlayer.isMuted();
        if (state.html5Player) return state.html5Player.muted;
        return false;
    }

    function playerToggleMute() {
        if (state.activePlayerType === 'youtube' && state.ytPlayer) {
            if (state.ytPlayer.isMuted()) state.ytPlayer.unMute();
            else state.ytPlayer.mute();
        } else if (state.html5Player) {
            state.html5Player.muted = !state.html5Player.muted;
        }
        updateVolumeIcon();
    }

    function updatePlayButton() {
        if (state.isPlaying) {
            dom.playIcon.style.display = 'none';
            dom.pauseIcon.style.display = 'block';
        } else {
            dom.playIcon.style.display = 'block';
            dom.pauseIcon.style.display = 'none';
        }
    }

    function updateVolumeIcon() {
        const muted = playerIsMuted();
        dom.volIcon.style.display = muted ? 'none' : 'block';
        dom.muteIcon.style.display = muted ? 'block' : 'none';
    }

    function updateAudioBars() {
        const bars = dom.mediaContainer.querySelector('.audio-bars');
        if (!bars) return;
        if (state.isPlaying) bars.classList.remove('paused');
        else bars.classList.add('paused');
    }

    // ── Schedule Action at Server Time ────────────────────────────────
    function scheduleAt(executeAt, action) {
        const localExecuteTime = executeAt - state.clockOffset;
        const delay = localExecuteTime - Date.now();
        if (delay <= 0) {
            action();
        } else {
            setTimeout(action, delay);
        }
    }

    // ── Progress Tracking ─────────────────────────────────────────────
    function startProgressTracking() {
        stopProgressTracking();
        state.progressInterval = setInterval(updateProgress, 250);
    }

    function stopProgressTracking() {
        if (state.progressInterval) {
            clearInterval(state.progressInterval);
            state.progressInterval = null;
        }
    }

    function updateProgress() {
        const current = playerGetCurrentTime();
        const duration = playerGetDuration();
        if (duration > 0) {
            const pct = (current / duration) * 100;
            dom.progressFill.style.width = `${pct}%`;
            dom.progressThumb.style.left = `${pct}%`;
            dom.timeCurrent.textContent = formatTime(current);
            dom.timeDuration.textContent = formatTime(duration);
            state.duration = duration;
        }
    }

    // ── Heartbeat (drift detection) ───────────────────────────────────
    function startHeartbeat() {
        stopHeartbeat();
        state.heartbeatInterval = setInterval(() => {
            if (state.isPlaying && state.media) {
                state.socket.emit('heartbeat', { position: playerGetCurrentTime() });
            }
        }, 5000);
    }

    function stopHeartbeat() {
        if (state.heartbeatInterval) {
            clearInterval(state.heartbeatInterval);
            state.heartbeatInterval = null;
        }
    }

    // ── Load Media ────────────────────────────────────────────────────
    function loadYoutubeVideo(videoId, title) {
        hideAllPlayers();
        dom.youtubeContainer.style.display = 'block';
        dom.mediaPlaceholder.style.display = 'none';

        state.activePlayerType = 'youtube';
        state.media = { type: 'youtube', url: videoId, title };

        if (state.ytPlayer && state.ytReady) {
            state.ytPlayer.loadVideoById(videoId);
            state.ytPlayer.pauseVideo();
        } else {
            // YT player will be created in onYouTubeIframeAPIReady
            createYouTubePlayer(videoId);
        }

        showMediaUI(title);
    }

    function loadLocalFile(url, title, isAudio) {
        hideAllPlayers();
        dom.mediaPlaceholder.style.display = 'none';

        if (isAudio) {
            state.activePlayerType = 'audio';
            state.html5Player = dom.audioPlayer;
            dom.audioPlayer.src = url;
            dom.audioPlayer.style.display = 'none'; // Audio player hidden, we show bars instead
            dom.mediaContainer.classList.add('audio-mode');
            // Create audio visualizer
            let viz = dom.mediaContainer.querySelector('.audio-visualizer');
            if (!viz) {
                viz = document.createElement('div');
                viz.className = 'audio-visualizer';
                viz.innerHTML = `
          <div class="audio-bars paused">
            <div class="audio-bar"></div><div class="audio-bar"></div>
            <div class="audio-bar"></div><div class="audio-bar"></div>
            <div class="audio-bar"></div><div class="audio-bar"></div>
            <div class="audio-bar"></div>
          </div>
          <p class="audio-title">${title}</p>
        `;
                dom.mediaContainer.appendChild(viz);
            } else {
                viz.querySelector('.audio-title').textContent = title;
            }
        } else {
            state.activePlayerType = 'video';
            state.html5Player = dom.html5Player;
            dom.html5Player.src = url;
            dom.html5Player.style.display = 'block';
            dom.mediaContainer.classList.remove('audio-mode');
        }

        state.media = { type: isAudio ? 'audio' : 'video', url, title };
        showMediaUI(title);
    }

    function hideAllPlayers() {
        dom.youtubeContainer.style.display = 'none';
        dom.html5Player.style.display = 'none';
        dom.audioPlayer.style.display = 'none';
        dom.mediaContainer.classList.remove('audio-mode');
        const viz = dom.mediaContainer.querySelector('.audio-visualizer');
        if (viz) viz.remove();
    }

    function showMediaUI(title) {
        dom.progressContainer.style.display = 'block';
        dom.controls.style.display = 'flex';
        dom.nowPlayingPanel.style.display = 'block';
        dom.nowPlayingTitle.textContent = title || 'Unknown';
        startProgressTracking();
        startHeartbeat();
    }

    // ── YouTube Player Setup ──────────────────────────────────────────
    function createYouTubePlayer(videoId) {
        if (state.ytPlayer) {
            state.ytPlayer.destroy();
            state.ytPlayer = null;
            state.ytReady = false;
        }
        state.ytPlayer = new YT.Player('youtube-player', {
            videoId: videoId,
            playerVars: {
                autoplay: 0,
                controls: 0,
                disablekb: 1,
                modestbranding: 1,
                rel: 0,
                showinfo: 0,
                iv_load_policy: 3,
                playsinline: 1,
            },
            events: {
                onReady: () => {
                    state.ytReady = true;
                    state.ytPlayer.setVolume(parseInt(dom.volumeSlider.value, 10));
                },
                onStateChange: (event) => {
                    if (state.suppressEvents) return;
                    // We don't auto-sync on YT state changes to avoid loops
                },
            },
        });
    }

    // Global callback for YouTube API
    window.onYouTubeIframeAPIReady = () => {
        // Player will be created when needed
    };

    // ── Socket.IO Events ──────────────────────────────────────────────
    function connectSocket() {
        state.socket = io({ transports: ['websocket'] });

        state.socket.on('connect', async () => {
            state.userId = state.socket.id;
            await performClockSync();
            // Re-sync clock every 30s
            setInterval(performClockSync, 30000);
        });

        // ─ Media Loaded ─
        state.socket.on('media-loaded', ({ media, playback }) => {
            if (!media) return;
            if (media.type === 'youtube') {
                const videoId = extractYoutubeId(media.url) || media.url;
                loadYoutubeVideo(videoId, media.title);
            } else {
                const isAudio = media.type === 'audio';
                loadLocalFile(media.url, media.title, isAudio);
            }
            toast(`Now playing: ${media.title}`, 'info');
        });

        // ─ Sync Play ─
        state.socket.on('sync-play', ({ position, executeAt }) => {
            scheduleAt(executeAt, () => {
                playerSeek(position);
                playerPlay();
            });
            updateSyncStatus('synced');
        });

        // ─ Sync Pause ─
        state.socket.on('sync-pause', ({ position, executeAt }) => {
            scheduleAt(executeAt, () => {
                playerSeek(position);
                playerPause();
            });
            updateSyncStatus('synced');
        });

        // ─ Sync Seek ─
        state.socket.on('sync-seek', ({ position, executeAt, playing }) => {
            scheduleAt(executeAt, () => {
                playerSeek(position);
                if (playing) playerPlay();
                else playerPause();
            });
            updateSyncStatus('synced');
        });

        // ─ Drift Correction ─
        state.socket.on('drift-correction', ({ expectedPosition, drift }) => {
            if (Math.abs(drift) > 0.05) {
                playerSeek(expectedPosition);
                updateSyncStatus('synced');
            }
        });

        // ─ User Events ─
        state.socket.on('user-joined', ({ user, users }) => {
            state.users = users;
            renderUsers();
            toast(`${user.name} joined`, 'success');
        });

        state.socket.on('user-left', ({ userId, users }) => {
            const leftUser = state.users.find(u => u.id === userId);
            state.users = users;
            renderUsers();
            if (leftUser) toast(`${leftUser.name} left`, 'info');
        });

        state.socket.on('host-changed', ({ newHostId }) => {
            state.isHost = (newHostId === state.userId);
            state.users.forEach(u => { u.isHost = (u.id === newHostId); });
            renderUsers();
            updateHostUI();
            if (state.isHost) toast("You're now the host!", 'success');
        });

        state.socket.on('disconnect', () => {
            toast('Disconnected from server', 'error');
        });

        state.socket.on('connect_error', () => {
            toast('Connection error', 'error');
        });
    }

    function updateSyncStatus(status) {
        const dot = dom.syncStatus.querySelector('.sync-dot');
        const text = dom.syncStatus.querySelector('span:last-child');
        dot.className = `sync-dot ${status}`;
        text.textContent = status === 'synced' ? 'Synced' : status === 'drifting' ? 'Correcting...' : 'Error';
    }

    // ── Room UI ───────────────────────────────────────────────────────
    function renderUsers() {
        dom.userList.innerHTML = '';
        state.users.forEach(user => {
            const li = document.createElement('li');
            const initial = user.name.charAt(0).toUpperCase();
            li.innerHTML = `
        <div class="user-avatar">${initial}</div>
        <span class="user-name">${user.name}</span>
        ${user.isHost ? '<span class="user-host-badge">Host</span>' : ''}
        ${user.id === state.userId ? '<span class="user-you">(you)</span>' : ''}
      `;
            dom.userList.appendChild(li);
        });
        dom.userCount.textContent = `${state.users.length}/5`;
    }

    // ── Event Handlers ────────────────────────────────────────────────
    function bindEvents() {
        // Create Room
        dom.createBtn.addEventListener('click', () => {
            const name = dom.createName.value.trim();
            if (!name) return showError('Enter your name');
            dom.createBtn.disabled = true;
            state.socket.emit('create-room', { userName: name }, (res) => {
                dom.createBtn.disabled = false;
                if (!res.success) return showError(res.error);
                state.roomCode = res.roomCode;
                state.userName = name;
                state.isHost = res.isHost;
                state.users = res.users;
                enterRoom();
            });
        });

        // Join Room
        dom.joinBtn.addEventListener('click', () => {
            const code = dom.joinCode.value.trim().toUpperCase();
            const name = dom.joinName.value.trim();
            if (!code) return showError('Enter room code');
            if (!name) return showError('Enter your name');
            dom.joinBtn.disabled = true;
            state.socket.emit('join-room', { roomCode: code, userName: name }, (res) => {
                dom.joinBtn.disabled = false;
                if (!res.success) return showError(res.error);
                state.roomCode = res.roomCode;
                state.userName = name;
                state.isHost = res.isHost;
                state.users = res.users;
                enterRoom();
                // Load existing media if any
                if (res.media) {
                    if (res.media.type === 'youtube') {
                        const videoId = extractYoutubeId(res.media.url) || res.media.url;
                        loadYoutubeVideo(videoId, res.media.title);
                    } else {
                        const isAudio = res.media.type === 'audio';
                        loadLocalFile(res.media.url, res.media.title, isAudio);
                    }
                    // Sync to current position
                    if (res.playback) {
                        setTimeout(() => {
                            playerSeek(res.playback.position);
                            if (res.playback.playing) playerPlay();
                        }, 1000);
                    }
                }
            });
        });

        // Enter on inputs
        dom.createName.addEventListener('keydown', e => { if (e.key === 'Enter') dom.createBtn.click(); });
        dom.joinCode.addEventListener('keydown', e => { if (e.key === 'Enter') dom.joinName.focus(); });
        dom.joinName.addEventListener('keydown', e => { if (e.key === 'Enter') dom.joinBtn.click(); });

        // Copy room code
        dom.copyRoomBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(state.roomCode).then(() => {
                toast('Room code copied!', 'success');
            });
        });

        // Leave room
        dom.leaveBtn.addEventListener('click', () => {
            state.socket.disconnect();
            stopHeartbeat();
            stopProgressTracking();
            hideAllPlayers();
            dom.mediaPlaceholder.style.display = 'flex';
            dom.progressContainer.style.display = 'none';
            dom.controls.style.display = 'none';
            dom.nowPlayingPanel.style.display = 'none';
            state.media = null;
            state.isPlaying = false;
            showScreen('landing');
            // Reconnect socket for next session
            connectSocket();
        });

        // Load YouTube
        dom.loadYoutubeBtn.addEventListener('click', () => {
            const url = dom.youtubeUrl.value.trim();
            if (!url) return;
            const videoId = extractYoutubeId(url);
            if (!videoId) return toast('Invalid YouTube URL', 'error');
            state.socket.emit('load-media', { type: 'youtube', url, title: `YouTube: ${videoId}` });
            dom.youtubeUrl.value = '';
        });
        dom.youtubeUrl.addEventListener('keydown', e => { if (e.key === 'Enter') dom.loadYoutubeBtn.click(); });

        // File upload
        dom.fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const isAudio = file.type.startsWith('audio/');
            const isVideo = file.type.startsWith('video/');
            if (!isAudio && !isVideo) return toast('Please select an audio or video file', 'error');
            if (file.size > 200 * 1024 * 1024) return toast('File too large (max 200MB)', 'error');

            // Show upload progress
            dom.uploadProgress.style.display = 'block';
            dom.uploadFill.style.width = '0%';
            dom.uploadText.textContent = 'Uploading...';

            const formData = new FormData();
            formData.append('file', file);

            try {
                const xhr = new XMLHttpRequest();
                xhr.open('POST', '/upload');

                xhr.upload.addEventListener('progress', (e) => {
                    if (e.lengthComputable) {
                        const pct = (e.loaded / e.total) * 100;
                        dom.uploadFill.style.width = `${pct}%`;
                        dom.uploadText.textContent = `Uploading... ${Math.round(pct)}%`;
                    }
                });

                xhr.addEventListener('load', () => {
                    dom.uploadProgress.style.display = 'none';
                    if (xhr.status === 200) {
                        const data = JSON.parse(xhr.responseText);
                        const mediaType = isAudio ? 'audio' : 'video';
                        state.socket.emit('load-media', { type: mediaType, url: data.url, title: file.name });
                        toast('File uploaded!', 'success');
                    } else {
                        toast('Upload failed', 'error');
                    }
                });

                xhr.addEventListener('error', () => {
                    dom.uploadProgress.style.display = 'none';
                    toast('Upload failed', 'error');
                });

                xhr.send(formData);
            } catch (err) {
                dom.uploadProgress.style.display = 'none';
                toast('Upload failed', 'error');
            }

            // Reset input
            dom.fileInput.value = '';
        });

        // Play/Pause
        dom.btnPlay.addEventListener('click', () => {
            if (!state.isHost || !state.media) return;
            const pos = playerGetCurrentTime();
            if (state.isPlaying) {
                state.socket.emit('pause', { position: pos });
            } else {
                state.socket.emit('play', { position: pos });
            }
        });

        // Rewind / Forward
        dom.btnRewind.addEventListener('click', () => {
            if (!state.isHost || !state.media) return;
            const pos = Math.max(0, playerGetCurrentTime() - 10);
            state.socket.emit('seek', { position: pos });
        });

        dom.btnForward.addEventListener('click', () => {
            if (!state.isHost || !state.media) return;
            const pos = Math.min(playerGetDuration(), playerGetCurrentTime() + 10);
            state.socket.emit('seek', { position: pos });
        });

        // Progress bar seek
        dom.progressBar.addEventListener('click', (e) => {
            if (!state.isHost || !state.media) return;
            const rect = dom.progressBar.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            const pos = pct * playerGetDuration();
            state.socket.emit('seek', { position: pos });
        });

        // Volume
        dom.volumeSlider.addEventListener('input', (e) => {
            playerSetVolume(parseInt(e.target.value, 10));
        });

        dom.btnVolume.addEventListener('click', () => {
            playerToggleMute();
        });

        // HTML5 player events
        [dom.html5Player, dom.audioPlayer].forEach(player => {
            player.addEventListener('loadedmetadata', () => {
                state.duration = player.duration;
                dom.timeDuration.textContent = formatTime(player.duration);
            });
        });
    }

    function showError(msg) {
        dom.landingError.textContent = msg;
        dom.landingError.style.display = 'block';
        setTimeout(() => { dom.landingError.style.display = 'none'; }, 3000);
    }

    function enterRoom() {
        showScreen('player');
        dom.roomCodeDisplay.textContent = state.roomCode;
        renderUsers();
        updateHostUI();
        dom.landingError.style.display = 'none';
    }

    // ── Boot ──────────────────────────────────────────────────────────
    function init() {
        connectSocket();
        bindEvents();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
