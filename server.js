const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// รายการคำศัพท์สภาวิชาชีพฯ 24 คำ
const WORD_LIST = [
    "SWPC", "OnePlatform", "สภาวิชาชีพ", "สังคมสงเคราะห์", "จริยธรรม",
    "ใบอนุญาต", "ส่งเสริมวิชาชีพ", "สวัสดิการ", "บริการสังคม", "เคารพศักดิ์ศรี",
    "คุ้มครองสิทธิ", "ความเท่าเทียม", "การช่วยเหลือ", "เครือข่ายวิชาชีพ", "เคสการพัฒนา",
    "นวัตกรรมสังคม", "จรรยาบรรณ", "พัฒนาศักยภาพ", "นักสังคมสงเคราะห์", "พลังสังคม",
    "สร้างโอกาส", "ความยั่งยืน", "จิตอาสา", "องค์กรวิชาชีพ"
];

let gameState = {
    isGameStarted: false,
    drawnWords: [],
    players: {},
    availableCards: [],
    winners: []
};

function generateBingoCard() {
    let shuffled = [...WORD_LIST].sort(() => 0.5 - Math.random());
    let card = [];
    let idx = 0;

    for (let r = 0; r < 3; r++) {
        let rowArr = [];
        for (let c = 0; c < 3; c++) {
            if (r === 1 && c === 1) {
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

function initializeCards() {
    gameState.availableCards = [];
    for (let i = 1; i <= 30; i++) {
        gameState.availableCards.push({
            id: i,
            card: generateBingoCard(),
            selectedBy: null
        });
    }
}
initializeCards();

function checkBingo3x3(card, drawnWords) {
    let marked = card.map(row => 
        row.map(val => val === "FREE" || drawnWords.includes(val))
    );

    for (let r = 0; r < 3; r++) {
        if (marked[r].every(v => v === true)) return true;
    }
    for (let c = 0; c < 3; c++) {
        if ([0,1,2].every(r => marked[r][c] === true)) return true;
    }
    if ([0,1,2].every(i => marked[i][i] === true)) return true;
    if ([0,1,2].every(i => marked[i][2 - i] === true)) return true;

    return false;
}

io.on('connection', (socket) => {
    const avatars = ['🦊', '🐱', '🐶', '🦁', '🐼', '🐨', '🐯', '🐰'];
    const randomAvatar = avatars[Math.floor(Math.random() * avatars.length)];

    socket.emit('init-data', {
        cards: gameState.availableCards,
        isGameStarted: gameState.isGameStarted,
        drawnWords: gameState.drawnWords,
        wordList: WORD_LIST,
        winners: gameState.winners,
        players: Object.values(gameState.players)
    });

    socket.on('register-player', (data) => {
        const { name, surname, org, cardId } = data;
        const cardObj = gameState.availableCards.find(c => c.id === cardId);
        
        if (cardObj && (!cardObj.selectedBy || cardObj.selectedBy === socket.id)) {
            cardObj.selectedBy = socket.id;
            gameState.players[socket.id] = {
                id: socket.id,
                name, surname, org, cardId,
                card: cardObj.card,
                avatar: randomAvatar
            };

            socket.emit('register-success', {
                player: gameState.players[socket.id],
                card: cardObj.card
            });

            io.emit('cards-updated', gameState.availableCards);
            io.emit('player-list-updated', Object.values(gameState.players));
        } else {
            socket.emit('error-msg', 'การ์ดใบนี้มีผู้เลือกแล้ว');
        }
    });

    socket.on('admin-start-game', () => {
        gameState.isGameStarted = true;
        io.emit('game-started');
    });

    socket.on('admin-draw-word', (data) => {
        const { word, playSound } = data;
        if (!WORD_LIST.includes(word)) return;
        if (gameState.drawnWords.includes(word)) return;

        gameState.drawnWords.push(word);
        
        io.emit('word-drawn', {
            word: word,
            history: gameState.drawnWords,
            playSound: playSound
        });
    });

    socket.on('admin-play-sfx', (soundType) => {
        io.emit('trigger-sfx', soundType);
    });

    // ตรวจสอบ BINGO และกระจายข่าวประกาศทันที!
    socket.on('claim-bingo', () => {
        const player = gameState.players[socket.id];
        if (player) {
            const isWinner = checkBingo3x3(player.card, gameState.drawnWords);
            if (isWinner) {
                const winnerInfo = {
                    socketId: socket.id,
                    name: `${player.name} ${player.surname}`,
                    org: player.org,
                    cardId: player.cardId,
                    time: new Date().toLocaleTimeString('th-TH'),
                    phone: 'กำลังกรอก...',
                    address: 'กำลังกรอก...'
                };

                // ส่งให้ผู้เล่นทราบเพื่อให้กรอกที่อยู่
                socket.emit('bingo-verified-winner', { cardId: player.cardId });

                // ประกาศแจ้งเตือนทุกคน (Admin + หน้าขึ้นจอใหญ่) ทันที!
                io.emit('bingo-alert-broadcast', winnerInfo);

            } else {
                socket.emit('bingo-rejected', '❌ การ์ดของคุณยังไม่ BINGO ครับ!');
            }
        }
    });

    // บันทึกที่อยู่เมื่อผู้ชนะส่งข้อมูลเรียบร้อย
    socket.on('submit-winner-info', (info) => {
        const player = gameState.players[socket.id];
        if (player) {
            const winnerData = {
                name: `${player.name} ${player.surname}`,
                org: player.org,
                cardId: player.cardId,
                phone: info.phone,
                address: info.address,
                time: new Date().toLocaleTimeString('th-TH')
            };

            // ปรับปรุงข้อมูลในรายการผู้ชนะ
            const existingIdx = gameState.winners.findIndex(w => w.cardId === player.cardId);
            if (existingIdx !== -1) {
                gameState.winners[existingIdx] = winnerData;
            } else {
                gameState.winners.push(winnerData);
            }

            io.emit('update-winners-list', gameState.winners);
        }
    });

    socket.on('admin-reset-game', () => {
        gameState.isGameStarted = false;
        gameState.drawnWords = [];
        gameState.players = {};
        gameState.winners = [];
        initializeCards();
        io.emit('game-reset', gameState.availableCards);
    });

    socket.on('disconnect', () => {
        if (gameState.players[socket.id]) {
            const cardId = gameState.players[socket.id].cardId;
            const cardObj = gameState.availableCards.find(c => c.id === cardId);
            if (cardObj) cardObj.selectedBy = null;
            delete gameState.players[socket.id];
            io.emit('cards-updated', gameState.availableCards);
            io.emit('player-list-updated', Object.values(gameState.players));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SWPC BINGO Server running on http://localhost:${PORT}`));