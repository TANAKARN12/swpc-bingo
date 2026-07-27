const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// ให้บริการไฟล์ Static (HTML, CSS, JS, SFX) จากโฟลเดอร์ public
app.use(express.static(path.join(__dirname, 'public')));

// รหัสผ่านสำหรับเข้าใช้งานแอดมิน
const ADMIN_PASSWORD = "swpc2026";

// รายการคำศัพท์อัตลักษณ์สภาวิชาชีพสังคมสงเคราะห์ (รายการกลาง แก้ไขได้สดๆ จากหน้าแอดมิน)
// โหมด 3x3 ใช้ 8 คำ (จากรายการนี้แบบสุ่ม) / โหมด 5x5 ใช้ 24 คำ (จากรายการนี้แบบสุ่ม)
const DEFAULT_WORD_LIST = [
    "SWPC", "OnePlatform", "สภาวิชาชีพ", "สังคมสงเคราะห์", "จริยธรรม",
    "ใบอนุญาต", "ส่งเสริมวิชาชีพ", "สวัสดิการ", "บริการสังคม", "เคารพศักดิ์ศรี",
    "คุ้มครองสิทธิ", "ความเท่าเทียม", "การช่วยเหลือ", "เครือข่ายวิชาชีพ", "เคสการพัฒนา",
    "นวัตกรรมสังคม", "จรรยาบรรณ", "พัฒนาศักยภาพ", "นักสังคมสงเคราะห์", "พลังสังคม",
    "สร้างโอกาส", "ความยั่งยืน", "จิตอาสา", "องค์กรวิชาชีพ"
];

// รายการอวตารสัตว์การ์ตูน 30 แบบ (ใช้อ้างอิงฝั่งเซิร์ฟเวอร์เป็น fallback เท่านั้น
// ตัวเลือกจริงของผู้เล่นจะถูกส่งมาจากฝั่ง client ตอน register-player)
const AVATARS = [
    '🦊', '🐱', '🐶', '🦁', '🐼', '🐨', '🐯', '🐰',
    '🐸', '🐵', '🦄', '🐧', '🐥', '🦉', '🐺', '🐗',
    '🐴', '🐝', '🐛', '🦋', '🐙', '🐬', '🐳', '🦔',
    '🦥', '🦦', '🦘', '🦡', '🦩', '🦚'
];

let gameState = {
    isGameStarted: false,
    roundNumber: 1, // เพิ่มทุกครั้งที่แอดมินกด Reset หรือเปิดรอบใหม่
    boardSize: 3, // 3 = 3x3, 5 = 5x5
    wordList: [...DEFAULT_WORD_LIST],
    drawnWords: [],
    players: {}, // socket.id -> player object (เฉพาะผู้เล่นที่ "ออนไลน์อยู่ตอนนี้" เท่านั้น)
    playersByToken: {}, // token -> player object : roster ถาวรที่ใช้จำตัวตนข้ามการรีเฟรช/หลุดเน็ต ("บัตรประจำตัว" ของผู้เล่น)
    tokenToSocket: {}, // token -> socket.id ปัจจุบัน (มีค่าเฉพาะตอนออนไลน์อยู่)
    waitingPlayers: {}, // socket.id -> true : ผู้ที่เข้ามาระหว่างรอบกำลังเล่นอยู่ ต้องรอรอบถัดไป
    availableCards: [],
    winners: [] // แต่ละรายการมี token + addressComplete กำกับไว้ เพื่อให้กรอกที่อยู่ย้อนหลังได้แม้ roster จะถูกล้างไปแล้ว
};

// แจ้งจำนวนผู้ที่กำลังรอรอบถัดไปให้ทุกหน้าจอทราบแบบเรียลไทม์
function broadcastWaitingCount() {
    io.emit('waiting-count-updated', { count: Object.keys(gameState.waitingPlayers).length });
}

// จำนวนคำศัพท์ที่ต้องใช้สำหรับกระดานขนาด NxN (ไม่รวมช่อง FREE ตรงกลาง)
function requiredWordsForSize(size) {
    return size * size - 1;
}

// ฟังก์ชันสุ่มตารางการ์ดบิงโก รองรับทั้งขนาด 3x3 และ 5x5 (ตรงกลางเป็นช่อง FREE เสมอ)
function generateBingoCard(size) {
    const required = requiredWordsForSize(size);
    let shuffled = [...gameState.wordList].sort(() => 0.5 - Math.random()).slice(0, required);
    let card = [];
    let idx = 0;
    const center = Math.floor(size / 2);

    for (let r = 0; r < size; r++) {
        let rowArr = [];
        for (let c = 0; c < size; c++) {
            if (r === center && c === center) {
                rowArr.push("FREE");
            } else {
                rowArr.push(shuffled[idx]);
                idx++;
            }
        }
        card.push(rowArr);
    }
    return card;
}

// ฟังก์ชันเริ่มต้นการ์ดบิงโก 30 ใบ ตามขนาดกระดานปัจจุบัน
// คืนค่า true ถ้าสร้างสำเร็จ, false ถ้าคำศัพท์ในระบบไม่พอสำหรับขนาดกระดานที่เลือก
function initializeCards() {
    const required = requiredWordsForSize(gameState.boardSize);
    if (gameState.wordList.length < required) {
        return false;
    }
    gameState.availableCards = [];
    for (let i = 1; i <= 30; i++) {
        gameState.availableCards.push({
            id: i,
            card: generateBingoCard(gameState.boardSize),
            selectedBy: null
        });
    }
    return true;
}
initializeCards();

// ฟังก์ชันตรวจสอบการบิงโกแบบทั่วไป (แนวนอน, แนวตั้ง, แนวทแยง 2 เส้น) สำหรับกระดานขนาด NxN
function checkBingoGrid(card, drawnWords, size) {
    let marked = card.map(row =>
        row.map(val => val === "FREE" || drawnWords.includes(val))
    );

    // ตรวจสอบแนวนอนทุกแถว
    for (let r = 0; r < size; r++) {
        if (marked[r].every(v => v === true)) return true;
    }
    // ตรวจสอบแนวตั้งทุกคอลัมน์
    for (let c = 0; c < size; c++) {
        if ([...Array(size).keys()].every(r => marked[r][c] === true)) return true;
    }
    // ตรวจสอบแนวทแยงซ้ายไปขวา
    if ([...Array(size).keys()].every(i => marked[i][i] === true)) return true;
    // ตรวจสอบแนวทแยงขวาไปซ้าย
    if ([...Array(size).keys()].every(i => marked[i][size - 1 - i] === true)) return true;

    return false;
}

// ตรวจการชนะสำหรับโหมด 3x3 (8 รูปแบบ: แนวนอน 3, แนวตั้ง 3, ทแยง 2)
function checkBingo3x3(card, drawnWords) {
    return checkBingoGrid(card, drawnWords, 3);
}

// ตรวจการชนะสำหรับโหมด 5x5 (12 รูปแบบ: แนวนอน 5, แนวตั้ง 5, ทแยง 2)
function checkBingo5x5(card, drawnWords) {
    return checkBingoGrid(card, drawnWords, 5);
}

// ฟังก์ชันกลางสำหรับ "เปิดรอบใหม่" ใช้ร่วมกันทั้ง 2 ปุ่มของแอดมิน (Reset All / รอบใหม่คงผู้เล่นเดิม)
// wipeRoster = true  -> "รีเซ็ตทั้งหมด": ล้างทุกอย่างจริง ทุกคนต้องกรอกชื่อ+เลือกการ์ดใหม่หมด (รวมคนที่กำลังรอคิวด้วย)
// wipeRoster = false -> "รอบใหม่ (คงผู้เล่นเดิม)": สับไพ่ใหม่ทั้งชุด แล้วแจกการ์ดอัตโนมัติให้ 2 กลุ่มโดยไม่ต้องกรอกฟอร์มซ้ำ
//   (1) ผู้เล่นเดิมในรอบก่อนที่ยังออนไลน์อยู่ตอนนี้ (สิทธิ์ก่อน)
//   (2) ผู้ที่กำลังรอคิวอยู่ (join-waiting-room) เรียงตามลำดับที่เข้าคิว
//   รวมกันได้สูงสุด 30 คน/รอบ (เท่าจำนวนการ์ดที่มี) ถ้าเกินโควตา คนที่เหลือจะถูกเก็บไว้ในคิวรอรอบถัดไปต่อไปอัตโนมัติ
function startNewRound({ wipeRoster }) {
    gameState.roundNumber += 1;
    gameState.drawnWords = [];

    if (wipeRoster) {
        gameState.players = {};
        gameState.playersByToken = {};
        gameState.tokenToSocket = {};
        gameState.waitingPlayers = {};
        gameState.isGameStarted = false;
        const ok = initializeCards();
        return { admitted: [], overflow: [], ok };
    }

    const ok = initializeCards();
    const newPlayers = {};
    const newWaitingPlayers = {};
    const admitted = [];
    const overflow = [];

    if (ok) {
        let cardCursor = 0;

        // มอบการ์ดใบใหม่ให้ socket ที่ระบุ โดยคง/ออก token ตัวตนให้เรียบร้อย คืนค่า true ถ้ามีการ์ดพอ
        const assignCard = (socketId, baseInfo) => {
            if (cardCursor >= gameState.availableCards.length) return false;
            const cardObj = gameState.availableCards[cardCursor++];
            cardObj.selectedBy = socketId;

            const token = baseInfo.token || crypto.randomUUID();
            const updated = {
                ...baseInfo,
                id: socketId,
                socketId,
                token,
                avatar: baseInfo.avatar || AVATARS[Math.floor(Math.random() * AVATARS.length)],
                card: cardObj.card,
                cardId: cardObj.id
            };

            gameState.playersByToken[token] = updated;
            gameState.tokenToSocket[token] = socketId;
            newPlayers[socketId] = updated;

            const sock = io.sockets.sockets.get(socketId);
            if (sock) sock.data.token = token;

            admitted.push(updated);
            return true;
        };

        // ลำดับความสำคัญ 1: ผู้เล่นเดิมจากรอบก่อนที่ยังออนไลน์อยู่ตอนนี้
        Object.keys(gameState.playersByToken).forEach((token) => {
            const activeSocketId = gameState.tokenToSocket[token];
            if (!activeSocketId) return; // ออฟไลน์อยู่ ข้ามไป (ถ้ากลับมาใหม่ภายหลังต้องลงทะเบียน)
            assignCard(activeSocketId, gameState.playersByToken[token]);
        });

        // ลำดับความสำคัญ 2: ผู้ที่กำลังรอคิวอยู่ (คนที่มาสายระหว่างรอบก่อน) เรียงตามลำดับเข้าคิว
        Object.entries(gameState.waitingPlayers).forEach(([socketId, info]) => {
            const success = assignCard(socketId, info);
            if (!success) overflow.push({ socketId, info });
        });
    } else {
        // คำศัพท์ไม่พอสำหรับสร้างการ์ด -> ไม่มีใครได้การ์ดเลยในรอบนี้ ทุกคนกลับไปรอคิวเหมือนเดิม
        Object.keys(gameState.playersByToken).forEach((token) => {
            const activeSocketId = gameState.tokenToSocket[token];
            if (activeSocketId) overflow.push({ socketId: activeSocketId, info: gameState.playersByToken[token] });
        });
        Object.entries(gameState.waitingPlayers).forEach(([socketId, info]) => overflow.push({ socketId, info }));
    }

    // คนที่การ์ดไม่พอ (เกินโควตา 30 ใบ) หรือกรณีคำศัพท์ไม่พอ ให้กลับไปอยู่ในคิวรอรอบถัดไปต่อ ไม่ตกหล่นหายไปไหน
    overflow.forEach(({ socketId, info }) => { newWaitingPlayers[socketId] = info; });

    gameState.players = newPlayers;
    gameState.waitingPlayers = newWaitingPlayers;
    gameState.isGameStarted = ok; // ถ้าคำศัพท์ไม่พอจนสร้างการ์ดไม่ได้ ยังไม่ควรเข้าสถานะ "กำลังเล่น"

    return { admitted, overflow, ok };
}

io.on('connection', (socket) => {
    // สุ่มอวตารสัตว์สำรอง (fallback) ให้ผู้เล่นที่เชื่อมต่อเข้ามา เผื่อ client ไม่ได้ส่งอวตารมา
    const fallbackAvatar = AVATARS[Math.floor(Math.random() * AVATARS.length)];

    // ระบบยืนยันรหัสผ่านแอดมิน
    socket.on('admin-login', (pass) => {
        if (pass === ADMIN_PASSWORD) {
            socket.emit('admin-login-success');
        } else {
            socket.emit('admin-login-fail', 'รหัสผ่านไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง');
        }
    });

    // ส่งข้อมูลตั้งต้นให้หน้า Client ที่เพิ่งโหลดขึ้นมา
    socket.emit('init-data', {
        cards: gameState.availableCards,
        isGameStarted: gameState.isGameStarted,
        roundNumber: gameState.roundNumber,
        waitingCount: Object.keys(gameState.waitingPlayers).length,
        boardSize: gameState.boardSize,
        drawnWords: gameState.drawnWords,
        wordList: gameState.wordList,
        winners: gameState.winners,
        players: Object.values(gameState.players)
    });

    // ผู้เล่นเดิมกลับเข้ามาใหม่ (รีเฟรช/หลุดเน็ต/ปิดแอพ) ส่ง token ที่เก็บไว้ใน localStorage มาขอกู้คืนสถานะ
    // ทำงานได้ 3 กรณีแยกกัน: (1) roster ยังอยู่และมีการ์ดอยู่แล้ว -> พากลับเข้าเกม/การ์ดเดิมทันที ไม่ต้องกรอกชื่อซ้ำ
    // (2) roster ยังอยู่แต่การ์ดถูกล้าง (เช่นแอดมินเพิ่งเปลี่ยนขนาดกระดาน) -> พาไปเลือกการ์ดใหม่ ไม่ต้องกรอกชื่อซ้ำ
    // (3) roster ถูกล้างไปแล้ว (แอดมินกด "รีเซ็ตทั้งหมด") แต่ยังมีของรางวัลที่กรอกที่อยู่ไม่เสร็จผูกกับ token นี้อยู่
    // -> ยังต้องกรอกที่อยู่ได้อยู่เสมอ ไม่ว่าจะรีเซ็ตไปกี่รอบก็ตาม จนกว่าจะกรอกสำเร็จจริง
    socket.on('identify-player', (token) => {
        token = (token || '').toString();
        if (!token) {
            socket.emit('identify-failed');
            return;
        }

        const pendingWinner = gameState.winners.find(w => w.token === token && !w.addressComplete) || null;
        const roster = gameState.playersByToken[token];

        if (!roster && !pendingWinner) {
            socket.emit('identify-failed');
            return;
        }

        // ป้องกัน token ชนกัน: ถ้า token นี้กำลังถูกใช้งานอยู่จริงในแท็บ/อุปกรณ์อื่นที่ยังออนไลน์อยู่ตอนนี้
        // (เช่นเปิดหลายแท็บทดสอบในเบราว์เซอร์เดียวกัน ซึ่ง localStorage ใช้ร่วมกันทุกแท็บ) ห้ามแย่งตัวตนกัน
        // ให้ปฏิเสธไปเลย แท็บนี้จะกลับไปลงทะเบียนเป็นผู้เล่นใหม่แทน กันข้อมูลผู้เล่นเดิมพัง
        const activeSocketId = gameState.tokenToSocket[token];
        if (roster && activeSocketId && activeSocketId !== socket.id && io.sockets.sockets.get(activeSocketId)) {
            socket.emit('identify-failed');
            return;
        }

        socket.data.token = token;
        let restoredPlayer = null;
        let needsCardSelection = false;

        if (roster) {
            gameState.tokenToSocket[token] = socket.id;

            if (roster.cardId) {
                // ย้ายการจองการ์ดใบเดิมมาเป็น socket ปัจจุบัน (การ์ดใบนี้ถูกกันไว้ให้ token นี้เท่านั้นตั้งแต่ disconnect)
                const cardObj = gameState.availableCards.find(c => c.id === roster.cardId);
                if (cardObj) cardObj.selectedBy = socket.id;
                restoredPlayer = { ...roster, id: socket.id, socketId: socket.id };
                gameState.playersByToken[token] = restoredPlayer;
                gameState.players[socket.id] = restoredPlayer;
            } else {
                // roster ยังอยู่แต่ยังไม่มีการ์ด (เช่นแอดมินเพิ่งเปลี่ยนขนาดกระดานไประหว่างที่คนนี้หลุดการเชื่อมต่ออยู่)
                needsCardSelection = true;
                restoredPlayer = { ...roster, id: socket.id, socketId: socket.id };
                gameState.playersByToken[token] = restoredPlayer;
            }

            io.emit('player-list-updated', Object.values(gameState.players));
            io.emit('cards-updated', gameState.availableCards);
        }

        socket.emit('restore-session', {
            player: restoredPlayer,
            card: (restoredPlayer && !needsCardSelection) ? restoredPlayer.card : null,
            needsCardSelection,
            isGameStarted: gameState.isGameStarted,
            roundNumber: gameState.roundNumber,
            drawnWords: gameState.drawnWords,
            pendingWinner: pendingWinner
        });
    });

    // ผู้เล่นที่กรอกฟอร์มเข้ามาระหว่างรอบกำลังเล่นอยู่ -> เข้าคิวรอรอบถัดไป (ไม่ให้เลือกการ์ดในรอบปัจจุบัน)
    // เก็บชื่อ/องค์กร/avatar ไว้ด้วย เพื่อให้แอดมินกด "รอบใหม่ (คงผู้เล่นเดิม)" แล้วรับเข้าเล่นได้ทันที ไม่ต้องกรอกซ้ำ
    socket.on('join-waiting-room', (data) => {
        gameState.waitingPlayers[socket.id] = {
            name: (data && data.name) || '',
            surname: (data && data.surname) || '',
            org: (data && data.org) || '',
            avatar: (data && data.avatar) || fallbackAvatar
        };
        broadcastWaitingCount();
    });

    // ระบบลงทะเบียนเลือกการ์ดผู้เล่น
    socket.on('register-player', (data) => {
        // กันเคสจังหวะแอดมินกด Start Game พร้อมๆ กับที่ผู้เล่นกำลังเลือกการ์ดอยู่พอดี (race condition)
        if (gameState.isGameStarted) {
            socket.emit('registration-blocked', {
                message: 'รอบนี้เริ่มเล่นไปแล้วครับ กรุณารอรอบถัดไป',
                roundNumber: gameState.roundNumber
            });
            gameState.waitingPlayers[socket.id] = {
                name: data.name || '', surname: data.surname || '', org: data.org || '', avatar: data.avatar || fallbackAvatar
            };
            broadcastWaitingCount();
            return;
        }

        const { name, surname, org, cardId, avatar } = data;
        const cardObj = gameState.availableCards.find(c => c.id === cardId);

        if (cardObj && (!cardObj.selectedBy || cardObj.selectedBy === socket.id)) {
            cardObj.selectedBy = socket.id;

            // ใช้ token เดิมซ้ำถ้า socket นี้เคยมีตัวตนอยู่แล้ว (เช่นกำลังเลือกการ์ดใหม่หลังแอดมินเปลี่ยนขนาดกระดาน
            // หรือเคยเป็นผู้ชนะที่กรอกที่อยู่ค้างไว้) เพื่อไม่ให้เกิด token ซ้ำซ้อนโดยไม่จำเป็น
            // ถ้าไม่เคยมีเลยจริงๆ ค่อยออกบัตรประจำตัวใบใหม่ให้
            const token = socket.data.token || crypto.randomUUID();
            const playerRecord = {
                id: socket.id,
                socketId: socket.id,
                token,
                name, surname, org, cardId,
                card: cardObj.card,
                avatar: avatar || fallbackAvatar
            };

            gameState.players[socket.id] = playerRecord;
            gameState.playersByToken[token] = playerRecord;
            gameState.tokenToSocket[token] = socket.id;
            socket.data.token = token;

            // ลงทะเบียนสำเร็จแล้ว ไม่ต้องอยู่ในคิวรอรอบถัดไป (ถ้ามี)
            if (gameState.waitingPlayers[socket.id]) {
                delete gameState.waitingPlayers[socket.id];
                broadcastWaitingCount();
            }

            socket.emit('register-success', {
                player: playerRecord,
                card: cardObj.card,
                token
            });

            // อัปเดตสถานะการ์ดและรายชื่อผู้เล่นไปยังทุกคน
            io.emit('cards-updated', gameState.availableCards);
            io.emit('player-list-updated', Object.values(gameState.players));
        } else {
            socket.emit('error-msg', 'ขออภัย การ์ดใบนี้มีผู้เลือกใช้งานแล้ว');
        }
    });

    // แอดมินสั่งเริ่มเกม
    socket.on('admin-start-game', () => {
        gameState.isGameStarted = true;
        io.emit('game-started');
    });

    // แอดมินเลือกขนาดกระดาน (3x3 / 5x5) ก่อนเริ่มเกม
    // หมายเหตุสำคัญ: ไม่ล้าง "ตัวตน" ผู้เล่นเลย (roster / playersByToken ยังอยู่ครบ) เคลียร์แค่ "การ์ดที่ถืออยู่ตอนนี้"
    // เพราะการ์ดขนาดเดิมใช้กับกระดานขนาดใหม่ไม่ได้ ผู้เล่นจะถูกพากลับไปแค่หน้าเลือกการ์ดใหม่เท่านั้น ไม่ต้องกรอกชื่อซ้ำ
    socket.on('admin-set-board-size', (size) => {
        size = parseInt(size, 10);
        if (size !== 3 && size !== 5) return;

        gameState.boardSize = size;
        gameState.players = {}; // ล้างเฉพาะ "สถานะกำลังถือการ์ดใบไหนอยู่" ของทุกคน
        gameState.isGameStarted = false; // เปิด Lobby ใหม่ให้เลือกการ์ด (กันเคส isGameStarted ค้าง true จนเลือกการ์ดใหม่ไม่ได้)

        // เก็บชื่อ/องค์กร/avatar/token ของทุกคนไว้ใน roster เหมือนเดิม แค่ล้างการ์ดออกเพื่อบังคับให้เลือกใหม่
        Object.keys(gameState.playersByToken).forEach((token) => {
            gameState.playersByToken[token] = { ...gameState.playersByToken[token], card: null, cardId: null };
        });

        const ok = initializeCards();

        io.emit('board-size-updated', {
            boardSize: gameState.boardSize,
            cards: gameState.availableCards,
            isGameStarted: false
        });
        io.emit('player-list-updated', []);

        if (!ok) {
            socket.emit('word-op-error', `คำศัพท์ในระบบไม่พอสำหรับโหมด ${size}x${size} (ต้องการ ${requiredWordsForSize(size)} คำ แต่มีอยู่ ${gameState.wordList.length} คำ) กรุณาเพิ่มคำศัพท์ก่อน`);
        }
    });

    // แอดมินเพิ่มคำศัพท์ใหม่เข้ารายการกลาง (Real-time CRUD)
    socket.on('admin-add-word', (word) => {
        word = (word || '').toString().trim();
        if (!word) return;

        if (gameState.wordList.includes(word)) {
            socket.emit('word-op-error', 'คำศัพท์นี้มีอยู่ในระบบแล้ว');
            return;
        }

        gameState.wordList.push(word);
        const ok = initializeCards();

        io.emit('word-list-updated', {
            wordList: gameState.wordList,
            cards: gameState.availableCards,
            boardSize: gameState.boardSize
        });

        if (!ok) {
            socket.emit('word-op-error', `คำศัพท์ยังไม่พอสำหรับโหมด ${gameState.boardSize}x${gameState.boardSize} (ต้องการ ${requiredWordsForSize(gameState.boardSize)} คำ)`);
        }
    });

    // แอดมินลบคำศัพท์ออกจากรายการกลาง (Real-time CRUD)
    socket.on('admin-remove-word', (word) => {
        gameState.wordList = gameState.wordList.filter(w => w !== word);
        gameState.drawnWords = gameState.drawnWords.filter(w => w !== word);
        const ok = initializeCards();

        io.emit('word-list-updated', {
            wordList: gameState.wordList,
            cards: gameState.availableCards,
            boardSize: gameState.boardSize
        });
        io.emit('word-drawn', {
            word: null,
            history: gameState.drawnWords,
            playSound: false
        });

        if (!ok) {
            socket.emit('word-op-error', `คำศัพท์ยังไม่พอสำหรับโหมด ${gameState.boardSize}x${gameState.boardSize} (ต้องการ ${requiredWordsForSize(gameState.boardSize)} คำ)`);
        }
    });

    // แอดมินสุ่ม/ประกาศคำศัพท์
    socket.on('admin-draw-word', (data) => {
        const { word, playSound } = data;
        if (!gameState.wordList.includes(word)) return;
        if (gameState.drawnWords.includes(word)) return;

        gameState.drawnWords.push(word);

        io.emit('word-drawn', {
            word: word,
            history: gameState.drawnWords,
            playSound: playSound
        });
    });

    // แอดมินกดเล่นเอฟเฟกต์เสียงสด (SFX Broadcast)
    socket.on('admin-play-sfx', (soundType) => {
        io.emit('trigger-sfx', soundType);
    });

    // ตรวจสอบสถานะ BINGO เมื่อมีคนกดปุ่ม BINGO!
    socket.on('claim-bingo', () => {
        const player = gameState.players[socket.id];
        if (player) {
            const isWinner = gameState.boardSize === 5
                ? checkBingo5x5(player.card, gameState.drawnWords)
                : checkBingo3x3(player.card, gameState.drawnWords);

            if (isWinner) {
                const winnerInfo = {
                    socketId: socket.id,
                    token: player.token || null, // ผูกกับตัวตนถาวร ให้กรอกที่อยู่ย้อนหลังได้แม้แอดมินจะกด Reset ไปแล้ว
                    name: `${player.name} ${player.surname}`,
                    org: player.org,
                    cardId: player.cardId,
                    avatar: player.avatar,
                    roundNumber: gameState.roundNumber,
                    time: new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                    phone: 'กำลังกรอก...',
                    address: 'กำลังกรอก...',
                    addressComplete: false
                };

                // ส่งการยืนยันกลับไปยังผู้ชนะ เพื่อแสดงป๊อปอัปกรอกที่อยู่
                socket.emit('bingo-verified-winner', { cardId: player.cardId });

                // ประกาศแจ้งเตือนผู้ชนะไปยังทุกหน้าจอ (ทั้งผู้เล่นและแอดมิน)
                io.emit('bingo-alert-broadcast', winnerInfo);

            } else {
                socket.emit('bingo-rejected', '❌ การ์ดของคุณยังไม่ BINGO ครับ!');
            }
        }
    });

    // บันทึกข้อมูลเบอร์โทรและที่อยู่จัดส่งของผู้ชนะ
    // ค้นหา winner เดิมด้วย token ของ socket นี้เป็นหลัก (ทำงานได้แม้ roster/players จะถูกแอดมินกด Reset ล้างไปแล้วก็ตาม)
    socket.on('submit-winner-info', (info) => {
        const token = socket.data.token || (gameState.players[socket.id] && gameState.players[socket.id].token);
        if (!token) return;

        const winnerIdx = gameState.winners.findIndex(w => w.token === token && !w.addressComplete);
        if (winnerIdx === -1) return;

        gameState.winners[winnerIdx] = {
            ...gameState.winners[winnerIdx],
            phone: info.phone || '-',
            address: info.address || '-',
            addressComplete: true
        };

        // ส่งข้อมูลผู้ชนะฉบับอัปเดตที่อยู่แล้วให้ Admin Dashboard
        io.emit('update-winners-list', gameState.winners);
        socket.emit('winner-info-saved');
    });

    // แอดมินสั่งรีเซ็ตระบบเกมใหม่ทั้งหมด = ล้าง roster ทุกคน (รวมคนที่กำลังรอคิวด้วย) ทุกคนต้องกรอกชื่อ+เลือกการ์ดใหม่หมด
    // (คงรายชื่อผู้ชนะไว้เสมอ และไม่ตัดการเชื่อมต่อฝั่งแอดมิน)
    socket.on('admin-reset-game', () => {
        const { ok } = startNewRound({ wipeRoster: true });

        io.emit('game-reset', {
            cards: gameState.availableCards,
            boardSize: gameState.boardSize,
            roundNumber: gameState.roundNumber
        });
        io.emit('player-list-updated', []);
        io.emit('waiting-count-updated', { count: 0 });

        if (!ok) {
            socket.emit('word-op-error', `คำศัพท์ในระบบไม่พอสำหรับโหมด ${gameState.boardSize}x${gameState.boardSize} กรุณาเพิ่มคำศัพท์ก่อนเริ่มรอบใหม่`);
        }
    });

    // แอดมินสั่งเปิด "รอบใหม่ (คงผู้เล่นเดิม)" = สับไพ่ใหม่ทั้งชุด แต่ไม่ล้าง roster
    // รับทั้งผู้เล่นเดิมที่ยังออนไลน์อยู่ และผู้ที่กำลังรอคิวอยู่ (คนมาสายระหว่างรอบก่อน) เข้าเล่นพร้อมกันทันที
    // ไม่ต้องมีใครกรอกฟอร์มซ้ำเลย รวมกันได้สูงสุด 30 คน/รอบ (เท่าจำนวนการ์ด) ถ้าเกินโควตาจะเก็บคนที่เหลือไว้รอรอบถัดไปอัตโนมัติ
    socket.on('admin-new-round-keep-players', () => {
        const { admitted, overflow, ok } = startNewRound({ wipeRoster: false });

        io.emit('new-round-keep-players', {
            cards: gameState.availableCards,
            boardSize: gameState.boardSize,
            roundNumber: gameState.roundNumber,
            players: Object.values(gameState.players),
            admittedCount: admitted.length,
            overflowCount: overflow.length
        });

        // ส่งการ์ดใบใหม่ไปหาผู้เล่นแต่ละคนแบบเจาะจง (private) เพื่อพาเข้าเกมได้ทันทีโดยไม่ต้องกดอะไรเพิ่ม
        admitted.forEach((p) => {
            io.to(p.id).emit('your-new-card', { card: p.card, cardId: p.cardId, roundNumber: gameState.roundNumber });
        });

        // คนที่การ์ดไม่พอ (เกินโควตา 30 ใบ) แจ้งให้ทราบว่ายังอยู่ในคิว รอรอบถัดไปให้อัตโนมัติ
        overflow.forEach(({ socketId }) => {
            io.to(socketId).emit('registration-blocked', {
                message: `ขออภัยครับ รอบนี้เต็มแล้ว (สูงสุด ${gameState.availableCards.length} ใบ/รอบ) กรุณารอรอบถัดไป`,
                roundNumber: gameState.roundNumber
            });
        });

        broadcastWaitingCount();

        if (!ok) {
            socket.emit('word-op-error', `คำศัพท์ในระบบไม่พอสำหรับโหมด ${gameState.boardSize}x${gameState.boardSize} กรุณาเพิ่มคำศัพท์ก่อนเปิดรอบใหม่`);
        } else if (overflow.length > 0) {
            socket.emit('round-capacity-warning', `⚠️ มีผู้เล่นเกินโควตา ${overflow.length} คน (การ์ดมีสูงสุด ${gameState.availableCards.length} ใบ/รอบ) ระบบเก็บคนที่เหลือไว้ในคิวรอรอบถัดไปให้แล้วครับ`);
        }
    });

    // แอดมินสั่งล้างเฉพาะตารางผู้ชนะ (แยกจากปุ่มรีเซ็ตเกม)
    socket.on('admin-clear-winners', () => {
        gameState.winners = [];
        io.emit('update-winners-list', gameState.winners);
    });

    // จัดการเมื่อผู้ใช้หลุดการเชื่อมต่อ
    // หมายเหตุสำคัญ: ตั้งแต่มีระบบ token จำตัวตนแล้ว "ไม่คืนการ์ดให้คนอื่นแย่งทันที" ตอนหลุดการเชื่อมต่อ
    // เพราะอาจเป็นแค่หลุดเน็ตชั่วคราว (พบบ่อยในงานอีเวนต์ที่ใช้ wifi สาธารณะ) — การ์ดจะถูกจองไว้ให้ token เดิม
    // จนกว่าจะ identify-player กลับมาสำเร็จ หรือแอดมินเปิดรอบใหม่ (ซึ่งจะสุ่มการ์ดชุดใหม่ทั้งหมดอยู่แล้ว)
    socket.on('disconnect', () => {
        const token = socket.data.token;
        if (token && gameState.tokenToSocket[token] === socket.id) {
            delete gameState.tokenToSocket[token];
        }
        if (gameState.players[socket.id]) {
            delete gameState.players[socket.id];
            io.emit('player-list-updated', Object.values(gameState.players));
        }
        if (gameState.waitingPlayers[socket.id]) {
            delete gameState.waitingPlayers[socket.id];
            broadcastWaitingCount();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 SWPC BINGO Server running on http://localhost:${PORT}`));