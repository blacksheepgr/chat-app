const socket = io();
let currentUsername = '';
let currentRoom = 'general';
let soundEnabled = true;
let darkMode = false;
let onlineUsers = [];
let rooms = [];
let messagePage = 1;
let loadingMessages = false;
let hasMoreMessages = true;

// Check authentication
fetch('/api/check-auth')
    .then(res => res.json())
    .then(data => {
        if (data.authenticated) {
            currentUsername = data.username;
            document.getElementById('currentUsername').textContent = currentUsername;
            document.getElementById('userAvatar').src = data.avatar || '/images/default-avatar.svg';
            document.getElementById('userStatus').textContent = data.status;
            
            // Show admin buttons if user is admin
            if (data.role === 'admin') {
                document.getElementById('adminBtn').style.display = 'inline-block';
                document.getElementById('clearAllBtn').style.display = 'inline-block';
            }
            
            socket.emit('join', { username: currentUsername, room: 'general' });
            loadRooms();
            loadUsers();
        } else {
            window.location.href = '/login.html';
        }
    });

// Admin panel button
document.getElementById('adminBtn').addEventListener('click', () => {
    window.location.href = '/admin.html';
});

// Clear all messages (Admin only)
document.getElementById('clearAllBtn').addEventListener('click', async () => {
    if (!confirm('🚨 ΠΡΟΣΟΧΗ! Θα διαγραφούν ΟΛΑ τα μηνύματα από ΟΛΑ τα rooms!\n\nΕίσαι σίγουρος;')) return;
    
    const password = prompt('Για ασφάλεια, πληκτρολόγησε τον κωδικό σου:');
    if (!password) return;
    
    try {
        const response = await fetch('/api/admin/clear-all-messages', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ 
                username: currentUsername,
                password: password 
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            alert('✅ Όλα τα μηνύματα διαγράφηκαν!');
            location.reload();
        } else {
            alert('❌ Λάθος κωδικός!');
        }
    } catch (err) {
        alert('Σφάλμα: ' + err.message);
    }
});

// Logout
document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
});

// Load rooms
async function loadRooms() {
    const response = await fetch('/api/rooms');
    rooms = await response.json();
    displayRooms();
}

function displayRooms() {
    const roomsList = document.getElementById('rooms-list');
    roomsList.innerHTML = rooms.map(room => `
        <div class="room-item ${room.name === currentRoom ? 'active' : ''}" onclick="switchRoom('${room.name}')">
            <i class="fas fa-door-${room.isPrivate ? 'lock' : 'open'}"></i>
            ${room.name}
        </div>
    `).join('');
}

// Switch room
window.switchRoom = function(room) {
    currentRoom = room;
    document.getElementById('currentRoom').textContent = room;
    document.getElementById('messages').innerHTML = '';
    messagePage = 1;
    hasMoreMessages = true;
    
    socket.emit('change-room', { username: currentUsername, newRoom: room });
    loadMessages(room);
    displayRooms();
};

// Load messages with pagination
async function loadMessages(room, page = 1) {
    if (loadingMessages || !hasMoreMessages) return;
    
    loadingMessages = true;
    const response = await fetch(`/api/messages/${room}?page=${page}`);
    const data = await response.json();
    
    if (data.messages.length < 50) hasMoreMessages = false;
    
    const messagesDiv = document.getElementById('messages');
    data.messages.forEach(msg => addMessage(msg, false));
    
    if (page === 1) {
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
    
    messagePage = page + 1;
    loadingMessages = false;
}

// Load users
async function loadUsers() {
    const response = await fetch('/api/users');
    onlineUsers = await response.json();
    displayUsers();
}

function displayUsers() {
    const usersList = document.getElementById('users-list');
    const onlineCount = onlineUsers.filter(u => u.isOnline).length;
    document.getElementById('onlineCount').textContent = onlineCount;
    
    usersList.innerHTML = onlineUsers.map(user => `
        <div class="user-item ${user.isOnline ? 'online' : 'offline'}" onclick="startPrivateChat('${user.username}')">
            <img src="${user.avatar || '/images/default-avatar.svg'}" class="user-avatar" onerror="this.src='/images/default-avatar.svg'">
            <div class="user-details">
                <span class="username">${user.username}</span>
                <small class="status-text">${user.customStatus || user.status}</small>
            </div>
            ${user.isOnline ? '<span class="online-dot"></span>' : ''}
        </div>
    `).join('');
}

// Start private chat
window.startPrivateChat = function(targetUser) {
    if (targetUser === currentUsername) return;
    
    currentRoom = `private-${[currentUsername, targetUser].sort().join('-')}`;
    document.getElementById('currentRoom').textContent = `Private chat with ${targetUser}`;
    document.getElementById('messages').innerHTML = '';
    
    socket.emit('join-private', { username: currentUsername, targetUser });
    
    fetch(`/api/private/${targetUser}`)
        .then(res => res.json())
        .then(messages => {
            messages.forEach(msg => addMessage(msg, false));
        });
};

// Message handling
socket.on('recent-messages', (messages) => {
    messages.forEach(msg => addMessage(msg));
});

socket.on('message', (msg) => {
    addMessage(msg);
    if (soundEnabled && msg.username !== currentUsername) {
        playNotificationSound();
    }
});

socket.on('private-message', (msg) => {
    addMessage(msg);
    if (soundEnabled && msg.username !== currentUsername) {
        playNotificationSound();
    }
});

socket.on('system-message', (text) => {
    addSystemMessage(text);
});

function addMessage(msg, scroll = true) {
    const messagesDiv = document.getElementById('messages');
    const messageEl = document.createElement('div');
    messageEl.className = `message ${msg.username === currentUsername ? 'own' : ''} ${msg.messageType}`;
    messageEl.id = `msg-${msg._id}`;
    
    const time = new Date(msg.timestamp).toLocaleTimeString('el-GR', {
        hour: '2-digit', minute: '2-digit'
    });
    
    let content = '';
    if (msg.messageType === 'image') {
        content = `<img src="${msg.fileUrl}" class="message-image" onclick="window.open('${msg.fileUrl}')">`;
    } else if (msg.messageType === 'file') {
        content = `<a href="${msg.fileUrl}" target="_blank" class="file-link">
            <i class="fas fa-file"></i> ${msg.fileName} (${formatBytes(msg.fileSize)})
        </a>`;
    } else {
        content = msg.message;
    }
    
    let reactionsHtml = '';
    if (msg.reactions && msg.reactions.length > 0) {
        const reactionCounts = {};
        msg.reactions.forEach(r => reactionCounts[r.emoji] = (reactionCounts[r.emoji] || 0) + 1);
        reactionsHtml = Object.entries(reactionCounts).map(([emoji, count]) => `
            <span class="reaction" onclick="addReaction('${msg._id}', '${emoji}')">
                ${emoji} ${count}
            </span>
        `).join('');
    }
    
    messageEl.innerHTML = `
        <div class="message-header">
            <strong>${msg.username}</strong>
            <small>${time}</small>
            ${msg.edited ? '<small>(edited)</small>' : ''}
            ${msg.username === currentUsername ? `
                <div class="message-actions">
                    <i class="fas fa-edit" onclick="editMessage('${msg._id}')"></i>
                    <i class="fas fa-trash" onclick="deleteMessage('${msg._id}')"></i>
                </div>
            ` : ''}
        </div>
        <div class="message-content">${content}</div>
        <div class="message-reactions">${reactionsHtml}</div>
        <div class="message-readby">
            ${msg.readBy && msg.readBy.length ? `Read by: ${msg.readBy.join(', ')}` : ''}
        </div>
    `;
    
    messagesDiv.appendChild(messageEl);
    if (scroll) messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// Send message
document.getElementById('send-btn').addEventListener('click', sendMessage);
document.getElementById('message-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
    socket.emit('typing', { username: currentUsername, room: currentRoom, isTyping: true });
});

async function sendMessage() {
    const input = document.getElementById('message-input');
    const message = input.value.trim();
    
    if (message) {
        socket.emit('message', {
            username: currentUsername,
            message: message,
            room: currentRoom
        });
        input.value = '';
    }
}

// File upload
document.getElementById('fileBtn').addEventListener('click', () => {
    document.getElementById('fileInput').click();
});

document.getElementById('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const formData = new FormData();
    formData.append('file', file);
    
    const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData
    });
    
    const data = await response.json();
    
    if (data.success) {
        socket.emit('message', {
            username: currentUsername,
            message: '',
            room: currentRoom,
            fileData: data
        });
    }
});

// Edit message
window.editMessage = async function(messageId) {
    const newMessage = prompt('Edit message:');
    if (!newMessage) return;
    
    const response = await fetch(`/api/messages/${messageId}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ message: newMessage })
    });
    
    if (response.ok) {
        location.reload();
    }
};

// Delete message
window.deleteMessage = async function(messageId) {
    if (!confirm('Delete this message?')) return;
    
    const response = await fetch(`/api/messages/${messageId}`, {
        method: 'DELETE'
    });
    
    if (response.ok) {
        document.getElementById(`msg-${messageId}`).remove();
    }
};

// Add reaction
window.addReaction = async function(messageId, emoji) {
    await fetch(`/api/messages/${messageId}/reactions`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ emoji })
    });
};

// Typing indicator
let typingTimeout;
socket.on('typing', ({ username, isTyping }) => {
    const indicator = document.getElementById('typing-indicator');
    if (isTyping) {
        indicator.textContent = `${username} πληκτρολογεί...`;
        clearTimeout(typingTimeout);
        typingTimeout = setTimeout(() => {
            indicator.textContent = '';
        }, 1000);
    }
});

// Online users updates
socket.on('users-online', (users) => {
    onlineUsers = users;
    displayUsers();
});

socket.on('user-joined', ({ username }) => {
    addSystemMessage(`${username} μπήκε στο chat`);
});

socket.on('user-left', (username) => {
    addSystemMessage(`${username} έφυγε από το chat`);
});

// System message with sound for join/leave
function addSystemMessage(text) {
    const messagesDiv = document.getElementById('messages');
    const messageEl = document.createElement('div');
    messageEl.className = 'system-message';
    messageEl.textContent = text;
    messagesDiv.appendChild(messageEl);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    // ΠΑΙΞΕ ΗΧΟ ΓΙΑ ΕΙΣΟΔΟ/ΕΞΟΔΟ
    if (soundEnabled) {
        if (text.includes('μπήκε')) {
            playJoinSound();
        } else if (text.includes('έφυγε')) {
            playLeaveSound();
        }
    }
}

// Sound - Ωραίος ήχος για νέα μηνύματα
function playNotificationSound() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const now = audioContext.currentTime;
        
        const masterGain = audioContext.createGain();
        masterGain.connect(audioContext.destination);
        masterGain.gain.setValueAtTime(0.3, now);
        
        // Τρεις αρμονικές νότες
        const notes = [
            { freq: 523.25, time: 0.0, duration: 0.2 }, // C5
            { freq: 659.25, time: 0.1, duration: 0.2 }, // E5
            { freq: 783.99, time: 0.2, duration: 0.3 }  // G5
        ];
        
        notes.forEach(note => {
            const osc = audioContext.createOscillator();
            const gain = audioContext.createGain();
            
            osc.type = 'sine';
            osc.frequency.value = note.freq;
            
            osc.connect(gain);
            gain.connect(masterGain);
            
            gain.gain.setValueAtTime(0, now + note.time);
            gain.gain.linearRampToValueAtTime(0.25, now + note.time + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, now + note.time + note.duration);
            
            osc.start(now + note.time);
            osc.stop(now + note.time + note.duration);
        });
        
        // Αρμονική για πλούσιο ήχο
        const harmonic = audioContext.createOscillator();
        const harmonicGain = audioContext.createGain();
        harmonic.type = 'triangle';
        harmonic.frequency.value = 1046.50;
        harmonic.connect(harmonicGain);
        harmonicGain.connect(masterGain);
        harmonicGain.gain.setValueAtTime(0, now + 0.05);
        harmonicGain.gain.linearRampToValueAtTime(0.1, now + 0.1);
        harmonicGain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
        harmonic.start(now + 0.05);
        harmonic.stop(now + 0.4);
        
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }
    } catch(e) {
        console.log('Sound error:', e);
    }
}

// Sound για είσοδο (ανεβαίνει)
function playJoinSound() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const now = audioContext.currentTime;
        
        const masterGain = audioContext.createGain();
        masterGain.connect(audioContext.destination);
        masterGain.gain.setValueAtTime(0.2, now);
        
        // Ανεβαίνουσα κλίμακα
        [523.25, 659.25, 783.99].forEach((freq, i) => {
            const osc = audioContext.createOscillator();
            const gain = audioContext.createGain();
            
            osc.type = 'sine';
            osc.frequency.value = freq;
            
            osc.connect(gain);
            gain.connect(masterGain);
            
            gain.gain.setValueAtTime(0, now + i * 0.1);
            gain.gain.linearRampToValueAtTime(0.2, now + i * 0.1 + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.15);
            
            osc.start(now + i * 0.1);
            osc.stop(now + i * 0.1 + 0.15);
        });
        
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }
    } catch(e) {
        console.log('Sound error:', e);
    }
}

// Sound για έξοδο (κατεβαίνει)
function playLeaveSound() {
    try {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const now = audioContext.currentTime;
        
        const masterGain = audioContext.createGain();
        masterGain.connect(audioContext.destination);
        masterGain.gain.setValueAtTime(0.2, now);
        
        // Κατεβαίνουσα κλίμακα
        [783.99, 659.25, 523.25].forEach((freq, i) => {
            const osc = audioContext.createOscillator();
            const gain = audioContext.createGain();
            
            osc.type = 'sine';
            osc.frequency.value = freq;
            
            osc.connect(gain);
            gain.connect(masterGain);
            
            gain.gain.setValueAtTime(0, now + i * 0.1);
            gain.gain.linearRampToValueAtTime(0.2, now + i * 0.1 + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.15);
            
            osc.start(now + i * 0.1);
            osc.stop(now + i * 0.1 + 0.15);
        });
        
        if (audioContext.state === 'suspended') {
            audioContext.resume();
        }
    } catch(e) {
        console.log('Sound error:', e);
    }
}

// Sound toggle
document.getElementById('soundToggle').addEventListener('click', (e) => {
    soundEnabled = !soundEnabled;
    const icon = e.currentTarget.querySelector('i');
    icon.className = soundEnabled ? 'fas fa-volume-up' : 'fas fa-volume-mute';
});

// Theme toggle
document.getElementById('themeToggle').addEventListener('click', (e) => {
    darkMode = !darkMode;
    const icon = e.currentTarget.querySelector('i');
    icon.className = darkMode ? 'fas fa-sun' : 'fas fa-moon';
    document.body.classList.toggle('dark-mode', darkMode);
});

// Clear chat (local only)
document.getElementById('clearChat').addEventListener('click', () => {
    document.getElementById('messages').innerHTML = '';
});

// Emoji picker
document.getElementById('emojiBtn').addEventListener('click', () => {
    const picker = document.getElementById('emojiPicker');
    picker.style.display = picker.style.display === 'none' ? 'flex' : 'none';
});

window.addEmoji = function(emoji) {
    const input = document.getElementById('message-input');
    input.value += emoji;
    input.focus();
    document.getElementById('emojiPicker').style.display = 'none';
};

// Profile editing
document.getElementById('editProfileBtn').addEventListener('click', () => {
    document.getElementById('profileModal').style.display = 'flex';
});

document.getElementById('closeProfileModal').addEventListener('click', () => {
    document.getElementById('profileModal').style.display = 'none';
});

document.getElementById('profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const formData = new FormData();
    formData.append('status', document.getElementById('statusSelect').value);
    formData.append('customStatus', document.getElementById('customStatus').value);
    
    const avatarFile = document.getElementById('avatarInput').files[0];
    if (avatarFile) {
        formData.append('avatar', avatarFile);
    }
    
    const response = await fetch('/api/profile/update', {
        method: 'POST',
        body: formData
    });
    
    if (response.ok) {
        location.reload();
    }
});

// Create room
document.getElementById('createRoomBtn').addEventListener('click', () => {
    const name = prompt('Room name:');
    if (!name) return;
    
    const description = prompt('Description:');
    const isPrivate = confirm('Private room?');
    let password = null;
    
    if (isPrivate) {
        password = prompt('Password:');
    }
    
    fetch('/api/rooms', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ name, description, isPrivate, password })
    }).then(() => loadRooms());
});

// Scroll pagination
document.getElementById('messages').addEventListener('scroll', function() {
    if (this.scrollTop === 0 && hasMoreMessages && !loadingMessages) {
        loadMessages(currentRoom, messagePage);
    }
});

// Mobile menu
document.getElementById('menuToggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('show');
});

document.getElementById('closeSidebar').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('show');
});

// Utility function
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
