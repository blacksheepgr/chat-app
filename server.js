const express = require('express');
const mongoose = require('mongoose');
const socketIO = require('socket.io');
const http = require('http');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const path = require('path');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('fs-extra');
const mime = require('mime-types');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Ensure upload directories exist
fs.ensureDirSync(path.join(__dirname, 'public/uploads/avatars'));
fs.ensureDirSync(path.join(__dirname, 'public/uploads/files'));

// Middleware
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('public/uploads'));
app.use(cookieParser());

// Multer configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (file.fieldname === 'avatar') {
            cb(null, 'public/uploads/avatars/');
        } else {
            cb(null, 'public/uploads/files/');
        }
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: process.env.MAX_FILE_SIZE || 5242880 },
    fileFilter: (req, file, cb) => {
        if (file.fieldname === 'avatar') {
            if (file.mimetype.startsWith('image/')) {
                cb(null, true);
            } else {
                cb(new Error('Only images are allowed for avatar'));
            }
        } else {
            cb(null, true);
        }
    }
});

// MongoDB Schemas
const userSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    password: { type: String, required: true },
    email: { type: String, unique: true, sparse: true },
    avatar: { type: String, default: '/images/default-avatar.svg' },
    status: { type: String, default: 'available' },
    customStatus: { type: String, default: '' },
    role: { type: String, default: 'user', enum: ['user', 'admin', 'moderator'] },
    lastSeen: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
    isOnline: { type: Boolean, default: false },
    currentRoom: { type: String, default: 'general' }
});

const messageSchema = new mongoose.Schema({
    username: String,
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    message: String,
    room: { type: String, default: 'general' },
    privateTo: { type: String, default: null },
    messageType: { type: String, default: 'text', enum: ['text', 'image', 'file', 'system'] },
    fileUrl: String,
    fileName: String,
    fileSize: Number,
    edited: { type: Boolean, default: false },
    editedAt: Date,
    deleted: { type: Boolean, default: false },
    readBy: [{ type: String }],
    reactions: [{
        username: String,
        emoji: String,
        createdAt: { type: Date, default: Date.now }
    }],
    timestamp: { type: Date, default: Date.now }
});

const roomSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    description: String,
    createdBy: String,
    isPrivate: { type: Boolean, default: false },
    password: String,
    members: [{ type: String }],
    banned: [{ type: String }],
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const Room = mongoose.model('Room', roomSchema);

// Initialize default rooms
async function initRooms() {
    const rooms = ['general', 'random', 'tech', 'gaming'];
    for (const room of rooms) {
        await Room.findOneAndUpdate(
            { name: room },
            { name: room, description: `Welcome to ${room} room!`, createdBy: 'system' },
            { upsert: true }
        );
    }
}

// Authentication middleware
const authenticateToken = async (req, res, next) => {
    const token = req.cookies.token;
    if (!token) return res.redirect('/login.html');

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findOne({ username: decoded.username });
        if (!user) return res.redirect('/login.html');
        
        req.user = user;
        next();
    } catch (err) {
        return res.redirect('/login.html');
    }
};

const requireAdmin = async (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
};

// Routes - Authentication
app.post('/api/register', async (req, res) => {
    try {
        const { username, password, email } = req.body;
        
        const existingUser = await User.findOne({ $or: [{ username }, { email }] });
        if (existingUser) {
            return res.status(400).json({ error: 'Username or email already exists' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        
        const user = new User({
            username,
            password: hashedPassword,
            email
        });
        
        await user.save();
        
        const token = jwt.sign({ username, role: user.role }, process.env.JWT_SECRET);
        res.cookie('token', token, { httpOnly: true });
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        const user = await User.findOne({ username });
        if (!user) {
            return res.status(400).json({ error: 'User not found' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(400).json({ error: 'Invalid password' });
        }

        user.lastSeen = new Date();
        user.isOnline = true;
        await user.save();

        const token = jwt.sign({ username, role: user.role }, process.env.JWT_SECRET);
        res.cookie('token', token, { httpOnly: true });
        
        res.json({ success: true, role: user.role });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/logout', authenticateToken, async (req, res) => {
    await User.findByIdAndUpdate(req.user._id, { isOnline: false, lastSeen: new Date() });
    res.clearCookie('token');
    res.json({ success: true });
});

app.get('/api/check-auth', authenticateToken, (req, res) => {
    res.json({ 
        authenticated: true, 
        username: req.user.username,
        role: req.user.role,
        avatar: req.user.avatar,
        status: req.user.status,
        customStatus: req.user.customStatus
    });
});

// Profile update
app.post('/api/profile/update', authenticateToken, upload.single('avatar'), async (req, res) => {
    try {
        const { status, customStatus } = req.body;
        const updateData = { status, customStatus };
        
        if (req.file) {
            const filename = `avatar-${req.user._id}-${Date.now()}.jpg`;
            await sharp(req.file.path)
                .resize(200, 200)
                .jpeg({ quality: 80 })
                .toFile(path.join(__dirname, 'public/uploads/avatars/', filename));
            
            if (req.user.avatar && req.user.avatar !== '/images/default-avatar.svg') {
                const oldPath = path.join(__dirname, 'public', req.user.avatar);
                if (fs.existsSync(oldPath)) {
                    fs.unlinkSync(oldPath);
                }
            }
            
            updateData.avatar = '/uploads/avatars/' + filename;
        }
        
        await User.findByIdAndUpdate(req.user._id, updateData);
        
        io.emit('user-updated', {
            username: req.user.username,
            avatar: updateData.avatar || req.user.avatar,
            status: updateData.status || req.user.status,
            customStatus: updateData.customStatus || req.user.customStatus
        });
        
        res.json({ success: true, avatar: updateData.avatar });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// File upload
app.post('/api/upload', authenticateToken, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const fileUrl = '/uploads/files/' + req.file.filename;
        const fileType = req.file.mimetype.startsWith('image/') ? 'image' : 'file';
        
        res.json({
            success: true,
            fileUrl,
            fileName: req.file.originalname,
            fileSize: req.file.size,
            fileType
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get users list
app.get('/api/users', authenticateToken, async (req, res) => {
    try {
        const users = await User.find({}, 'username avatar status customStatus isOnline lastSeen role');
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get rooms
app.get('/api/rooms', authenticateToken, async (req, res) => {
    try {
        const rooms = await Room.find({ $or: [{ isPrivate: false }, { members: req.user.username }] });
        res.json(rooms);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Create room
app.post('/api/rooms', authenticateToken, async (req, res) => {
    try {
        const { name, description, isPrivate, password } = req.body;
        
        const existing = await Room.findOne({ name });
        if (existing) {
            return res.status(400).json({ error: 'Room already exists' });
        }
        
        const room = new Room({
            name,
            description,
            isPrivate,
            password: isPrivate ? await bcrypt.hash(password, 10) : undefined,
            createdBy: req.user.username,
            members: [req.user.username]
        });
        
        await room.save();
        
        io.emit('room-created', room);
        res.json({ success: true, room });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Join private room
app.post('/api/rooms/join', authenticateToken, async (req, res) => {
    try {
        const { name, password } = req.body;
        
        const room = await Room.findOne({ name });
        if (!room) {
            return res.status(404).json({ error: 'Room not found' });
        }
        
        if (room.isPrivate) {
            const valid = await bcrypt.compare(password, room.password);
            if (!valid) {
                return res.status(401).json({ error: 'Invalid password' });
            }
        }
        
        if (!room.members.includes(req.user.username)) {
            room.members.push(req.user.username);
            await room.save();
        }
        
        res.json({ success: true, room });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get message history
app.get('/api/messages/:room', authenticateToken, async (req, res) => {
    try {
        const { room } = req.params;
        const { page = 1, limit = 50 } = req.query;
        const skip = (page - 1) * limit;
        
        const query = { 
            room,
            privateTo: null,
            deleted: false
        };
        
        const messages = await Message.find(query)
            .sort({ timestamp: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .sort({ timestamp: 1 });
        
        const total = await Message.countDocuments(query);
        
        res.json({
            messages,
            total,
            page: parseInt(page),
            pages: Math.ceil(total / limit)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get private messages
app.get('/api/private/:user', authenticateToken, async (req, res) => {
    try {
        const { user } = req.params;
        const { page = 1, limit = 50 } = req.query;
        
        const messages = await Message.find({
            $or: [
                { privateTo: user, username: req.user.username },
                { privateTo: req.user.username, username: user }
            ],
            deleted: false
        })
        .sort({ timestamp: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .sort({ timestamp: 1 });
        
        res.json(messages);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Edit message
app.put('/api/messages/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { message } = req.body;
        
        const msg = await Message.findById(id);
        if (!msg) {
            return res.status(404).json({ error: 'Message not found' });
        }
        
        if (msg.username !== req.user.username && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        
        msg.message = message;
        msg.edited = true;
        msg.editedAt = new Date();
        await msg.save();
        
        io.emit('message-edited', msg);
        res.json({ success: true, message: msg });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Delete message
app.delete('/api/messages/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        
        const msg = await Message.findById(id);
        if (!msg) {
            return res.status(404).json({ error: 'Message not found' });
        }
        
        if (msg.username !== req.user.username && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Not authorized' });
        }
        
        msg.deleted = true;
        await msg.save();
        
        io.emit('message-deleted', { id: msg._id });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Add reaction
app.post('/api/messages/:id/reactions', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { emoji } = req.body;
        
        const msg = await Message.findById(id);
        if (!msg) {
            return res.status(404).json({ error: 'Message not found' });
        }
        
        msg.reactions = msg.reactions.filter(r => r.username !== req.user.username);
        msg.reactions.push({
            username: req.user.username,
            emoji
        });
        
        await msg.save();
        
        io.emit('message-reaction', msg);
        res.json({ success: true, message: msg });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin: Clear all messages
app.post('/api/admin/clear-all-messages', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { username, password } = req.body;
        
        const user = await User.findOne({ username });
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid password' });
        }
        
        await Message.deleteMany({});
        
        io.emit('system-message', 'Όλα τα μηνύματα διαγράφηκαν από τον admin');
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin routes
app.get('/api/admin/stats', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const totalUsers = await User.countDocuments();
        const onlineUsers = await User.countDocuments({ isOnline: true });
        const totalMessages = await Message.countDocuments();
        const totalRooms = await Room.countDocuments();
        const messagesToday = await Message.countDocuments({
            timestamp: { $gte: new Date().setHours(0,0,0,0) }
        });
        
        const topUsers = await Message.aggregate([
            { $group: { _id: '$username', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 }
        ]);
        
        res.json({
            totalUsers,
            onlineUsers,
            totalMessages,
            totalRooms,
            messagesToday,
            topUsers
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const users = await User.find({}, '-password');
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/admin/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { role } = req.body;
        
        await User.findByIdAndUpdate(id, { role });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/admin/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await User.findByIdAndDelete(id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/chat.html', authenticateToken, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/admin.html', authenticateToken, requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Socket.IO
const onlineUsers = new Map();

io.on('connection', (socket) => {
    console.log('New client connected');

    socket.on('join', async (data) => {
        const { username, room = 'general' } = data;
        
        onlineUsers.set(socket.id, { username, room });
        
        await User.findOneAndUpdate({ username }, { isOnline: true, currentRoom: room });
        
        socket.join(room);
        
        const recentMessages = await Message.find({ 
            room, 
            privateTo: null,
            deleted: false 
        })
        .sort({ timestamp: -1 })
        .limit(50)
        .sort({ timestamp: 1 });
        
        socket.emit('recent-messages', recentMessages);
        
        const onlineInRoom = await User.find({ isOnline: true, currentRoom: room });
        socket.emit('room-users', onlineInRoom);
        
        socket.broadcast.to(room).emit('user-joined', { username, room });
        
        const allOnline = await User.find({ isOnline: true });
        io.emit('users-online', allOnline);
    });

    socket.on('message', async (data) => {
        const { username, message, room = 'general', privateTo = null, fileData = null } = data;
        const user = await User.findOne({ username });
        
        let messageData = {
            username,
            userId: user._id,
            message,
            room: privateTo ? null : room,
            privateTo,
            messageType: 'text'
        };
        
        if (fileData) {
            messageData.messageType = fileData.fileType;
            messageData.fileUrl = fileData.fileUrl;
            messageData.fileName = fileData.fileName;
            messageData.fileSize = fileData.fileSize;
        }
        
        const savedMessage = new Message(messageData);
        await savedMessage.save();
        
        if (privateTo) {
            io.to(`user-${privateTo}`).to(`user-${username}`).emit('private-message', savedMessage);
        } else {
            io.to(room).emit('message', savedMessage);
        }
    });

    socket.on('typing', ({ username, room, isTyping }) => {
        socket.broadcast.to(room).emit('typing', { username, isTyping });
    });

    socket.on('join-private', ({ username, targetUser }) => {
        const roomId = [username, targetUser].sort().join('-');
        socket.join(`private-${roomId}`);
    });

    socket.on('change-room', async ({ username, newRoom }) => {
        const userData = onlineUsers.get(socket.id);
        if (userData) {
            socket.leave(userData.room);
            socket.join(newRoom);
            
            onlineUsers.set(socket.id, { ...userData, room: newRoom });
            await User.findOneAndUpdate({ username }, { currentRoom: newRoom });
            
            socket.broadcast.to(userData.room).emit('user-left', username);
            socket.broadcast.to(newRoom).emit('user-joined', { username, room: newRoom });
            
            const onlineInRoom = await User.find({ isOnline: true, currentRoom: newRoom });
            io.to(newRoom).emit('room-users', onlineInRoom);
        }
    });

    socket.on('mark-read', async ({ messageId, username }) => {
        await Message.findByIdAndUpdate(messageId, { $addToSet: { readBy: username } });
    });

    socket.on('disconnect', async () => {
        const userData = onlineUsers.get(socket.id);
        if (userData) {
            const { username, room } = userData;
            
            await User.findOneAndUpdate({ username }, { isOnline: false, lastSeen: new Date() });
            
            socket.broadcast.to(room).emit('user-left', username);
            
            const allOnline = await User.find({ isOnline: true });
            io.emit('users-online', allOnline);
            
            onlineUsers.delete(socket.id);
        }
    });
});

// Connect to MongoDB and initialize
mongoose.connect(process.env.MONGODB_URI)
    .then(async () => {
        console.log('Connected to MongoDB');
        await initRooms();
    })
    .catch(err => console.error('MongoDB connection error:', err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server is running on port ${PORT}`);
});
