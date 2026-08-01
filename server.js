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

// จำนวนผู้เล่นสูงสุดต่อรอบ (= จำนวนการ์ดที่สร้างไว้ล่วงหน้า) ปรับได้สดๆ จากหน้าแอดมิน (ดู admin-set-max-players)
// ค่าเริ่มต้นปรับจาก 30 -> 100 ตามคำขอ และอนุญาตให้แอดมินตั้งได้สูงสุด 300 คน/รอบ
const DEFAULT_MAX_PLAYERS = 100;
const MAX_PLAYERS_LIMIT = 300;

let gameState = {
    isGameStarted: false,
    roundNumber: 1, // เพิ่มทุกครั้งที่แอดมินกด Reset หรือเปิดรอบใหม่
    boardSize: 5, // ค่าเริ่มต้นของระบบคือ 5x5 (3/4/5/6 ปรับได้จากหน้าแอดมิน)
    maxPlayers: DEFAULT_MAX_PLAYERS, // จำนวนผู้เล่น/การ์ดสูงสุดต่อรอบ ปรับได้จากหน้าแอดมิน
    lastNearBingoCount: 0, // [ส่วนเพิ่ม] เก็บค่าล่าสุดที่เคยแจ้งเตือน "ใกล้ BINGO" ไปแล้ว กันแจ้งเตือนซ้ำถี่เกินไปทุกครั้งที่ออกคำใหม่
    wordList: [...DEFAULT_WORD_LIST],
    drawnWords: [],
    players: {}, // socket.id -> player object (เฉพาะผู้เล่นที่ "ออนไลน์อยู่ตอนนี้" เท่านั้น)
    playersByToken: {}, // token -> player object : roster ถาวรที่ใช้จำตัวตนข้ามการรีเฟรช/หลุดเน็ต ("บัตรประจำตัว" ของผู้เล่น)
    tokenToSocket: {}, // token -> socket.id ปัจจุบัน (มีค่าเฉพาะตอนออนไลน์อยู่)
    waitingPlayers: {}, // socket.id -> true : ผู้ที่เข้ามาระหว่างรอบกำลังเล่นอยู่ ต้องรอรอบถัดไป
    availableCards: [],
    winners: [], // แต่ละรายการมี token + addressComplete กำกับไว้ เพื่อให้กรอกที่อยู่ย้อนหลังได้แม้ roster จะถูกล้างไปแล้ว
    countdownActive: false, // true ระหว่างที่กำลังนับถอยหลัง "เรดี้...โก!" อยู่ (กันแอดมินกดเริ่มเกมซ้ำซ้อน)
    countdownTimeout: null, // เก็บ handle ของ setTimeout นับถอยหลังไว้ยกเลิกได้ถ้าแอดมิน Reset ระหว่างนับอยู่
    // เงื่อนไข/กติกาการเล่น: แก้ไขได้สดๆ จากหน้าแอดมิน ไม่ต้องแก้โค้ด ผู้เล่นกดปุ่ม "ℹ️" ที่หน้าลงทะเบียนเพื่ออ่านได้
    gameRules: `📜 กติกาการเล่น SWPC BINGO ONLINE

1. กรอกชื่อ-นามสกุล และหน่วยงาน/สังกัดให้ถูกต้องครบถ้วน เพื่อใช้อ้างอิงในการจัดส่งของรางวัล
2. ผู้เล่น 1 ท่าน เลือกการ์ดบิงโกได้เพียง 1 ใบต่อ 1 รอบการเล่นเท่านั้น
3. เมื่อผู้ดำเนินรายการประกาศคำศัพท์ ให้ตรวจสอบและทำเครื่องหมายในการ์ดของท่านหากมีคำนั้นปรากฏอยู่
4. เมื่อทำเครื่องหมายได้ครบ 1 แนว (แนวนอน แนวตั้ง หรือแนวทแยง) ให้กดปุ่ม "BINGO!" ทันที (กดปุ่ม 🏆 มุมซ้ายบนของจอ เพื่อดูตัวอย่างรูปแบบการชนะแบบภาพได้)
5. ระบบจะตรวจสอบและยืนยันผลอัตโนมัติ ผู้ที่กด BINGO ถูกต้องคนแรกในแนวนั้นจะได้รับสิทธิ์รับของรางวัล
6. กรุณากรอกเบอร์โทรศัพท์และที่อยู่จัดส่งของรางวัลให้ครบถ้วนและถูกต้องทันทีหลังระบบยืนยันว่าท่านชนะ
7. การตัดสินของคณะผู้จัดกิจกรรมถือเป็นที่สิ้นสุด`
};

// แจ้งจำนวนผู้ที่กำลังรอรอบถัดไปให้ทุกหน้าจอทราบแบบเรียลไทม์
function broadcastWaitingCount() {
    io.emit('waiting-count-updated', { count: Object.keys(gameState.waitingPlayers).length });
}

// สร้างรายชื่อ roster ผู้เล่นทั้งหมดที่เคยลงทะเบียนไว้ (ทั้งที่ออนไลน์อยู่ตอนนี้ และที่หลุดการเชื่อมต่อไปแล้วแต่ยังไม่ถูกล้าง roster)
// ใช้แสดงในหน้าแอดมินพร้อมสถานะออนไลน์/ออฟไลน์ ต่างจาก gameState.players ที่มีแค่คนออนไลน์ตอนนี้เท่านั้น
function buildRosterSnapshot() {
    return Object.values(gameState.playersByToken).map(p => ({
        token: p.token,
        name: p.name,
        surname: p.surname,
        org: p.org,
        avatar: p.avatar,
        cardId: p.cardId || null,
        online: !!(gameState.tokenToSocket[p.token] && io.sockets.sockets.get(gameState.tokenToSocket[p.token]))
    }));
}

// ส่ง roster ฉบับเต็ม (พร้อมสถานะออนไลน์/ออฟไลน์) ให้หน้าแอดมินเห็นแบบเรียลไทม์
function broadcastRoster() {
    io.emit('roster-updated', buildRosterSnapshot());
}

// จำนวนคำศัพท์ที่ต้องใช้สำหรับกระดานขนาด NxN (ขนาดคี่ 3x3/5x5 มีช่อง FREE ตรงกลาง 1 ช่อง ไม่นับรวม
// ขนาดคู่ 4x4/6x6 ไม่มีช่องกึ่งกลางที่แท้จริง จึงไม่มีช่อง FREE เลย ต้องใช้คำศัพท์เต็มทุกช่อง)
function requiredWordsForSize(size) {
    const hasFreeCenter = size % 2 === 1;
    return size * size - (hasFreeCenter ? 1 : 0);
}

// ฟังก์ชันสุ่มตารางการ์ดบิงโก รองรับขนาด 3x3, 4x4, 5x5, 6x6 (ขนาดคี่เท่านั้นที่มีช่อง FREE ตรงกลาง)
function generateBingoCard(size) {
    const hasFreeCenter = size % 2 === 1;
    const required = requiredWordsForSize(size);
    let shuffled = [...gameState.wordList].sort(() => 0.5 - Math.random()).slice(0, required);
    let card = [];
    let idx = 0;
    const center = Math.floor(size / 2);

    for (let r = 0; r < size; r++) {
        let rowArr = [];
        for (let c = 0; c < size; c++) {
            if (hasFreeCenter && r === center && c === center) {
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

// ฟังก์ชันเริ่มต้นชุดการ์ดบิงโก ตามจำนวน gameState.maxPlayers และขนาดกระดานปัจจุบัน
// คืนค่า true ถ้าสร้างสำเร็จ, false ถ้าคำศัพท์ในระบบไม่พอสำหรับขนาดกระดานที่เลือก
function initializeCards() {
    const required = requiredWordsForSize(gameState.boardSize);
    if (gameState.wordList.length < required) {
        return false;
    }
    gameState.availableCards = [];
    for (let i = 1; i <= gameState.maxPlayers; i++) {
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

// ตรวจการชนะแบบทั่วไป ใช้ได้กับกระดานทุกขนาดที่ระบบรองรับ (3x3, 4x4, 5x5, 6x6)
function checkBingoWin(card, drawnWords, size) {
    return checkBingoGrid(card, drawnWords, size);
}

// [ส่วนเพิ่ม] คำนวณจำนวนช่องที่ทำเครื่องหมายได้มากที่สุดในแนวเดียวกัน (แถว/คอลัมน์/ทแยง) ของการ์ดหนึ่งใบ
// ใช้ร่วมกับ countNearBingoPlayers() ด้านล่าง เพื่อดูว่าผู้เล่นคนนี้ "เหลืออีกกี่ช่อง" จะ BINGO
function maxMarkedInLine(card, drawnWords, size) {
    const marked = card.map(row => row.map(val => val === "FREE" || drawnWords.includes(val)));
    let maxMarked = 0;
    for (let r = 0; r < size; r++) {
        const count = marked[r].filter(Boolean).length;
        if (count > maxMarked) maxMarked = count;
    }
    for (let c = 0; c < size; c++) {
        let count = 0;
        for (let r = 0; r < size; r++) if (marked[r][c]) count++;
        if (count > maxMarked) maxMarked = count;
    }
    let diag1 = 0, diag2 = 0;
    for (let i = 0; i < size; i++) {
        if (marked[i][i]) diag1++;
        if (marked[i][size - 1 - i]) diag2++;
    }
    return Math.max(maxMarked, diag1, diag2);
}

// [ส่วนเพิ่ม] นับจำนวนผู้เล่นที่ "เหลืออีกแค่ 1 ช่องจะ BINGO" ในรอบปัจจุบัน (ไม่นับคนที่ BINGO ไปแล้วในรอบนี้)
// ใช้ส่งข้อความให้กำลังใจ/กระตุ้นบรรยากาศ เช่น "มีผู้เข้าใกล้ BINGO แล้ว 3 คน!" ไปยังทุกจอ
// [ส่วนแก้ไข] เดิมฟังก์ชันนี้คำนวณจาก "คำที่ประกาศไปแล้ว" เทียบกับการ์ด ทำให้ระบบนับว่าผู้เล่นใกล้ BINGO
// ทั้งที่ผู้เล่นอาจจะยังไม่ได้กดติ๊กช่องเลยสักช่องก็ได้ (ดูไม่สมเหตุสมผล ผู้เล่นงงว่าทำไมระบบรู้)
// ตอนนี้เปลี่ยนมาใช้ player.remaining ซึ่งอัปเดตจากฝั่งผู้เล่นเองทุกครั้งที่กดติ๊ก/ถอนติ๊กช่อง (ดู player-report-progress)
// นับเฉพาะคนที่ "กดติ๊กเองจริงๆ" จนเหลืออีกแค่ 1 ช่องเท่านั้น
function countNearBingoPlayers() {
    const winnerTokensThisRound = new Set(
        gameState.winners.filter(w => w.roundNumber === gameState.roundNumber).map(w => w.token)
    );
    let count = 0;
    for (const id in gameState.players) {
        const player = gameState.players[id];
        if (!player || !player.card) continue;
        if (player.token && winnerTokensThisRound.has(player.token)) continue; // ไม่นับคนที่ BINGO ไปแล้ว
        if (player.remaining === 1) count++;
    }
    return count;
}

// ฟังก์ชันกลางสำหรับ "เปิดรอบใหม่" ใช้ร่วมกันทั้ง 2 ปุ่มของแอดมิน (Reset All / รอบใหม่คงผู้เล่นเดิม)
// wipeRoster = true  -> "รีเซ็ตทั้งหมด": ล้างทุกอย่างจริง ทุกคนต้องกรอกชื่อ+เลือกการ์ดใหม่หมด (รวมคนที่กำลังรอคิวด้วย)
// wipeRoster = false -> "รอบใหม่ (คงผู้เล่นเดิม)": สับไพ่ใหม่ทั้งชุด แล้วแจกการ์ดอัตโนมัติให้ 2 กลุ่มโดยไม่ต้องกรอกฟอร์มซ้ำ
//   (1) ผู้เล่นเดิมในรอบก่อนที่ยังออนไลน์อยู่ตอนนี้ (สิทธิ์ก่อน)
//   (2) ผู้ที่กำลังรอคิวอยู่ (join-waiting-room) เรียงตามลำดับที่เข้าคิว
//   รวมกันได้สูงสุดเท่า gameState.maxPlayers คน/รอบ (เท่าจำนวนการ์ดที่มี) ถ้าเกินโควตา คนที่เหลือจะถูกเก็บไว้ในคิวรอรอบถัดไปต่อไปอัตโนมัติ
function startNewRound({ wipeRoster }) {
    gameState.lastNearBingoCount = 0; // [ส่วนเพิ่ม] รอบใหม่ เริ่มนับการแจ้งเตือน "ใกล้ BINGO" ใหม่ตั้งแต่ต้น
    // ยกเลิกการนับถอยหลังที่ค้างอยู่ (ถ้ามี) กันเคสแอดมิน Reset ระหว่างที่กำลังนับถอยหลัง "เรดี้...โก!" อยู่พอดี
    if (gameState.countdownTimeout) {
        clearTimeout(gameState.countdownTimeout);
        gameState.countdownTimeout = null;
    }
    gameState.countdownActive = false;

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
                cardId: cardObj.id,
                remaining: gameState.boardSize // การ์ดใบใหม่ ยังไม่ได้ติ๊กช่องไหนเลย รีเซ็ตค่าความคืบหน้า
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

    // คนที่การ์ดไม่พอ (เกินโควตา maxPlayers) หรือกรณีคำศัพท์ไม่พอ ให้กลับไปอยู่ในคิวรอรอบถัดไปต่อ ไม่ตกหล่นหายไปไหน
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
        maxPlayers: gameState.maxPlayers,
        drawnWords: gameState.drawnWords,
        wordList: gameState.wordList,
        winners: gameState.winners,
        players: Object.values(gameState.players),
        roster: buildRosterSnapshot(),
        gameRules: gameState.gameRules
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
            broadcastRoster(); // ผู้เล่นกลับมาออนไลน์แล้ว อัปเดตสถานะให้แอดมินเห็นทันที
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
                avatar: avatar || fallbackAvatar,
                remaining: gameState.boardSize // [ส่วนเพิ่ม] จำนวนช่องที่ "ผู้เล่นกดติ๊กเองจริงๆ" ยังขาดอีกกี่ช่องจะครบแนว (อัปเดตจาก player-report-progress)
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
            broadcastRoster();
        } else {
            socket.emit('error-msg', 'ขออภัย การ์ดใบนี้มีผู้เลือกใช้งานแล้ว');
        }
    });

    // แอดมินสั่งเริ่มเกม -> นับถอยหลัง "เรดี้...โก!" พร้อมกันทุกจอก่อน (เสียง+ภาพซิงค์กัน) แล้วค่อยเริ่มเกมจริง
    // ระยะเวลาต้องตรงกับจังหวะเสียง/ภาพนับถอยหลังฝั่ง client (ดู READY_GO_STEP_MS ใน index.html/admin.html)
    const READY_GO_DURATION_MS = 4200;
    socket.on('admin-start-game', () => {
        if (gameState.isGameStarted || gameState.countdownActive) return; // กันกดซ้ำระหว่างนับถอยหลัง/เกมเริ่มไปแล้ว
        gameState.countdownActive = true;
        io.emit('game-countdown'); // ทุกจอ (ผู้เล่น + จอกลาง + แอดมิน) นับถอยหลังพร้อมกันแบบเรียลไทม์

        gameState.countdownTimeout = setTimeout(() => {
            gameState.countdownActive = false;
            gameState.countdownTimeout = null;
            gameState.isGameStarted = true;
            io.emit('game-started');
        }, READY_GO_DURATION_MS);
    });

    // แอดมินเลือกขนาดกระดาน (3x3 / 5x5) ก่อนเริ่มเกม
    // หมายเหตุสำคัญ: ไม่ล้าง "ตัวตน" ผู้เล่นเลย (roster / playersByToken ยังอยู่ครบ) เคลียร์แค่ "การ์ดที่ถืออยู่ตอนนี้"
    // เพราะการ์ดขนาดเดิมใช้กับกระดานขนาดใหม่ไม่ได้ ผู้เล่นจะถูกพากลับไปแค่หน้าเลือกการ์ดใหม่เท่านั้น ไม่ต้องกรอกชื่อซ้ำ
    socket.on('admin-set-board-size', (size) => {
        size = parseInt(size, 10);
        if (![3, 4, 5, 6].includes(size)) return;

        gameState.boardSize = size;
        gameState.players = {}; // ล้างเฉพาะ "สถานะกำลังถือการ์ดใบไหนอยู่" ของทุกคน
        gameState.isGameStarted = false; // เปิด Lobby ใหม่ให้เลือกการ์ด (กันเคส isGameStarted ค้าง true จนเลือกการ์ดใหม่ไม่ได้)
        if (gameState.countdownTimeout) { clearTimeout(gameState.countdownTimeout); gameState.countdownTimeout = null; } // กันเคสเปลี่ยนขนาดกระดานระหว่างนับถอยหลังพอดี
        gameState.countdownActive = false;

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
        broadcastRoster();

        if (!ok) {
            socket.emit('word-op-error', `คำศัพท์ในระบบไม่พอสำหรับโหมด ${size}x${size} (ต้องการ ${requiredWordsForSize(size)} คำ แต่มีอยู่ ${gameState.wordList.length} คำ) กรุณาเพิ่มคำศัพท์ก่อน`);
        }
    });

    // แอดมินปรับจำนวนผู้เล่น/การ์ดสูงสุดต่อรอบ (ค่าเริ่มต้น 100 คน ปรับได้สูงสุด 300 คน)
    // หมายเหตุ: เหมือน admin-set-board-size คือจะสร้างชุดการ์ดใหม่ทั้งหมด จึงล้างเฉพาะ "การ์ดที่ถืออยู่" ของทุกคน
    // แต่ไม่ล้างชื่อ/องค์กร/avatar/token (roster ยังอยู่) ผู้เล่นแค่ต้องเลือกการ์ดใหม่อีกครั้ง
    socket.on('admin-set-max-players', (value) => {
        let n = parseInt(value, 10);
        if (!Number.isFinite(n)) return;
        n = Math.max(10, Math.min(MAX_PLAYERS_LIMIT, n));

        gameState.maxPlayers = n;
        gameState.players = {};
        gameState.isGameStarted = false;
        if (gameState.countdownTimeout) { clearTimeout(gameState.countdownTimeout); gameState.countdownTimeout = null; }
        gameState.countdownActive = false;

        Object.keys(gameState.playersByToken).forEach((token) => {
            gameState.playersByToken[token] = { ...gameState.playersByToken[token], card: null, cardId: null };
        });

        const ok = initializeCards();

        io.emit('max-players-updated', {
            maxPlayers: gameState.maxPlayers,
            boardSize: gameState.boardSize,
            cards: gameState.availableCards,
            isGameStarted: false
        });
        io.emit('player-list-updated', []);
        broadcastRoster();

        if (!ok) {
            socket.emit('word-op-error', `คำศัพท์ในระบบไม่พอสำหรับโหมด ${gameState.boardSize}x${gameState.boardSize} กรุณาเพิ่มคำศัพท์ก่อน`);
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

    // แอดมินแก้ไขเงื่อนไข/กติกาการเล่น (แก้สดๆ จากหลังบ้าน ไม่ต้องแตะโค้ด) แล้ว broadcast ให้ทุกหน้าจอที่เปิดค้างอยู่เห็นทันที
    socket.on('admin-update-rules', (rulesText) => {
        gameState.gameRules = (rulesText || '').toString().slice(0, 6000); // กันข้อความยาวเกินไปจนกินหน่วยความจำ
        io.emit('rules-updated', gameState.gameRules);
    });

    // แอดมินย้อนกลับคำศัพท์ล่าสุดที่เพิ่งประกาศไป (เผื่อพิธีกรพลาด/กดผิดคำ) โดยไม่ลบคำนั้นออกจากรายการกลาง
    // ต่างจาก admin-remove-word ตรงที่คำนี้ยังอยู่ในระบบ แค่ถือว่า "ยังไม่ได้ประกาศ" เท่านั้น ประกาศใหม่ได้อีกครั้ง
    socket.on('admin-undo-last-word', () => {
        const removedWord = gameState.drawnWords.pop();
        io.emit('word-drawn', {
            word: null,
            history: gameState.drawnWords,
            playSound: false
        });
        socket.emit('word-undo-result', removedWord || null);
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

        // [ปรับปรุง] แจ้งเตือนบรรยากาศ "มีผู้เข้าใกล้ BINGO แล้ว X คน!" เฉพาะตอนตัวเลขเปลี่ยนจากครั้งก่อนจริงๆ เท่านั้น
        // (เดิมยิงทุกครั้งที่ออกคำใหม่ตราบใดที่ nearCount > 0 ทำให้ถี่เกินไปจนน่ารำคาญ)
        const nearCount = countNearBingoPlayers();
        if (nearCount > 0 && nearCount !== gameState.lastNearBingoCount) {
            io.emit('near-bingo-update', { count: nearCount });
        }
        gameState.lastNearBingoCount = nearCount;
    });

    // แอดมินกดเล่นเอฟเฟกต์เสียงสด (SFX Broadcast)
    socket.on('admin-play-sfx', (soundType) => {
        io.emit('trigger-sfx', soundType);
    });

    // ตรวจสอบสถานะ BINGO เมื่อมีคนกดปุ่ม BINGO!
    // [ส่วนเพิ่ม] ผู้เล่นรายงานความคืบหน้าที่ตัวเอง "กดติ๊กเองจริงๆ" (ไม่ใช่คำนวณจากคำที่ประกาศไปแล้วเฉยๆ)
    // ใช้สำหรับแจ้งเตือนบรรยากาศ "ใกล้ BINGO" ให้สมเหตุสมผล เฉพาะคนที่กดติ๊กจนเหลือ 1 ช่องจริงๆ เท่านั้น
    socket.on('player-report-progress', (remaining) => {
        const player = gameState.players[socket.id];
        if (!player) return;
        const n = parseInt(remaining, 10);
        if (!Number.isFinite(n) || n < 0) return;
        player.remaining = n;
    });

    socket.on('claim-bingo', () => {
        const player = gameState.players[socket.id];
        if (player) {
            const isWinner = checkBingoWin(player.card, gameState.drawnWords, gameState.boardSize);

            if (isWinner) {
                // กันเคสกดปุ่ม BINGO ซ้ำ (ดับเบิลคลิก/เน็ตหน่วงแล้วกดซ้ำ) ไม่ให้ขึ้นแถวซ้ำในตารางผู้ชนะ
                const alreadyWon = gameState.winners.some(w => w.token === player.token && w.roundNumber === gameState.roundNumber);

                if (!alreadyWon) {
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

                    // *** จุดที่เคยขาดหายไป ***: ต้องบันทึกผู้ชนะเข้ารายการกลางจริงๆ ก่อน
                    // ไม่งั้นตอนกรอกที่อยู่ภายหลัง (submit-winner-info) จะหาแถวนี้ไม่เจอ กลายเป็นกรอกไปแล้วไม่ถูกบันทึกอะไรเลย
                    gameState.winners.push(winnerInfo);

                    // ประกาศแจ้งเตือนผู้ชนะไปยังทุกหน้าจอ (ทั้งผู้เล่นและแอดมิน)
                    io.emit('bingo-alert-broadcast', winnerInfo);
                    // อัปเดตตารางผู้ชนะให้แอดมินเห็นทันที (ขึ้นแถวไว้ก่อนเลย แม้ที่อยู่จะยังกรอกไม่เสร็จก็ตาม)
                    io.emit('update-winners-list', gameState.winners);
                }

                // ส่งการยืนยันกลับไปยังผู้ชนะ เพื่อแสดงป๊อปอัปกรอกที่อยู่ (แสดงซ้ำได้แม้กดปุ่มซ้ำ ไม่มีผลเสีย)
                socket.emit('bingo-verified-winner', { cardId: player.cardId });

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
            addressComplete: true,
            collectionMethod: 'delivery'
        };

        // ส่งข้อมูลผู้ชนะฉบับอัปเดตที่อยู่แล้วให้ Admin Dashboard
        io.emit('update-winners-list', gameState.winners);
        socket.emit('winner-info-saved', { collectionMethod: 'delivery' });
    });

    // [ส่วนเพิ่ม] ผู้ชนะเลือก "รับรางวัลแล้ว" (รับด้วยตนเองหน้างาน) ไม่ต้องกรอกเบอร์โทร/ที่อยู่
    socket.on('submit-winner-collected', () => {
        const token = socket.data.token || (gameState.players[socket.id] && gameState.players[socket.id].token);
        if (!token) return;

        const winnerIdx = gameState.winners.findIndex(w => w.token === token && !w.addressComplete);
        if (winnerIdx === -1) return;

        gameState.winners[winnerIdx] = {
            ...gameState.winners[winnerIdx],
            phone: '-',
            address: 'รับของรางวัลด้วยตนเองแล้ว (ไม่ต้องจัดส่ง)',
            addressComplete: true,
            collectionMethod: 'pickup'
        };

        io.emit('update-winners-list', gameState.winners);
        socket.emit('winner-info-saved', { collectionMethod: 'pickup' });
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
        broadcastRoster();

        if (!ok) {
            socket.emit('word-op-error', `คำศัพท์ในระบบไม่พอสำหรับโหมด ${gameState.boardSize}x${gameState.boardSize} กรุณาเพิ่มคำศัพท์ก่อนเริ่มรอบใหม่`);
        }
    });

    // แอดมินสั่งเปิด "รอบใหม่ (คงผู้เล่นเดิม)" = สับไพ่ใหม่ทั้งชุด แต่ไม่ล้าง roster
    // รับทั้งผู้เล่นเดิมที่ยังออนไลน์อยู่ และผู้ที่กำลังรอคิวอยู่ (คนมาสายระหว่างรอบก่อน) เข้าเล่นพร้อมกันทันที
    // ไม่ต้องมีใครกรอกฟอร์มซ้ำเลย รวมกันได้สูงสุดเท่า gameState.maxPlayers คน/รอบ (เท่าจำนวนการ์ด) ถ้าเกินโควตาจะเก็บคนที่เหลือไว้รอรอบถัดไปอัตโนมัติ
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

        // คนที่การ์ดไม่พอ (เกินโควตา maxPlayers) แจ้งให้ทราบว่ายังอยู่ในคิว รอรอบถัดไปให้อัตโนมัติ
        overflow.forEach(({ socketId }) => {
            io.to(socketId).emit('registration-blocked', {
                message: `ขออภัยครับ รอบนี้เต็มแล้ว (สูงสุด ${gameState.availableCards.length} ใบ/รอบ) กรุณารอรอบถัดไป`,
                roundNumber: gameState.roundNumber
            });
        });

        broadcastWaitingCount();
        broadcastRoster();

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
            broadcastRoster(); // ผู้เล่นคนนี้หลุดออฟไลน์แล้ว อัปเดตสถานะให้แอดมินเห็นทันที
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
