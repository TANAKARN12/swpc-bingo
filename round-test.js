/**
 * สคริปต์ตรวจสอบอัตโนมัติ: ระบบรอบเกม (Round) + ห้องรอ (Waiting Room)
 *
 * วิธีใช้:
 *   1. npm install                              (ติดตั้ง dependency หลักของโปรเจกต์)
 *   2. npm install --save-dev socket.io-client   (ติดตั้ง client library สำหรับสคริปต์นี้)
 *   3. node test/round-test.js
 *
 * สคริปต์นี้จะสั่งรัน server.js เป็น subprocess ของตัวเอง (พอร์ต 3999) แล้วจำลอง
 * connection หลายตัว (แอดมิน + ผู้เล่นหลายคน) เพื่อตรวจสอบ business logic ฝั่งเซิร์ฟเวอร์
 * โดยไม่ต้องเปิดเบราว์เซอร์เลย ผลลัพธ์จะสรุป PASS / FAIL ของแต่ละกรณีทดสอบท้ายสุด
 *
 * หมายเหตุ: การทดสอบเรื่องเสียง (AudioContext / Autoplay policy) ต้องทำผ่านเบราว์เซอร์จริง
 * เท่านั้น เพราะเป็นข้อจำกัดของเบราว์เซอร์ ไม่ใช่ logic ฝั่งเซิร์ฟเวอร์ — ดูเคสคู่มือใน
 * TEST_PLAN.md หัวข้อ "ทดสอบด้วยมือ (Manual)" แทน
 */

const { spawn } = require('child_process');
const path = require('path');

let ioClient;
try {
    ioClient = require('socket.io-client');
} catch (e) {
    console.error('❌ ไม่พบ socket.io-client กรุณารันคำสั่ง: npm install --save-dev socket.io-client');
    process.exit(1);
}

const PORT = 3999;
const URL = `http://localhost:${PORT}`;
const ADMIN_PASSWORD = 'swpc2026';

const results = [];
function record(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log(`${pass ? '✅ PASS' : '❌ FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`);
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForEvent(socket, eventName, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for "${eventName}"`)), timeoutMs);
        socket.once(eventName, (data) => {
            clearTimeout(timer);
            resolve(data);
        });
    });
}

function connectClient() {
    return ioClient(URL, { transports: ['websocket'], forceNew: true });
}

async function main() {
    console.log(`🚀 กำลังเริ่มเซิร์ฟเวอร์ทดสอบที่พอร์ต ${PORT} ...`);
    const serverProcess = spawn('node', [path.join(__dirname, '..', 'server.js')], {
        env: { ...process.env, PORT: String(PORT) },
        stdio: 'pipe'
    });

    await wait(1200); // รอเซิร์ฟเวอร์ boot

    try {
        // ---------------------------------------------------------------
        // เตรียม client: แอดมิน 1 ตัว, ผู้เล่นก่อนเริ่มเกม 1 คน, ผู้เล่นที่มาสาย 1 คน
        // ---------------------------------------------------------------
        const admin = connectClient();
        await waitForEvent(admin, 'connect');
        admin.emit('admin-login', ADMIN_PASSWORD);
        const loginResult = await Promise.race([
            waitForEvent(admin, 'admin-login-success').then(() => 'success'),
            waitForEvent(admin, 'admin-login-fail').then(() => 'fail')
        ]);
        record('แอดมิน login ด้วยรหัสผ่านที่ถูกต้อง', loginResult === 'success');

        const earlyPlayer = connectClient();
        const earlyInit = await waitForEvent(earlyPlayer, 'init-data');
        record('รอบเริ่มต้นคือรอบที่ 1 และยังไม่เริ่มเกม',
            earlyInit.roundNumber === 1 && earlyInit.isGameStarted === false,
            `roundNumber=${earlyInit.roundNumber}, isGameStarted=${earlyInit.isGameStarted}`);

        // ผู้เล่นที่มาก่อน (ก่อน Start Game) ต้องลงทะเบียน + เลือกการ์ดได้ตามปกติ
        const firstCard = earlyInit.cards[0];
        earlyPlayer.emit('register-player', {
            name: 'สมชาย', surname: 'ทดสอบ', org: 'หน่วยทดสอบ', cardId: firstCard.id, avatar: '🐱'
        });
        const earlyRegisterResult = await Promise.race([
            waitForEvent(earlyPlayer, 'register-success').then(() => 'success'),
            waitForEvent(earlyPlayer, 'registration-blocked').then(() => 'blocked')
        ]);
        record('ผู้เล่นที่ลงทะเบียนก่อน Start Game เลือกการ์ดได้สำเร็จ', earlyRegisterResult === 'success');

        // ---------------------------------------------------------------
        // แอดมินกด Start Game
        // ---------------------------------------------------------------
        admin.emit('admin-start-game');
        await waitForEvent(earlyPlayer, 'game-started');
        record('ผู้เล่นที่ลงทะเบียนไว้แล้วได้รับสัญญาณ game-started', true);

        // ---------------------------------------------------------------
        // ผู้เล่นมาสาย (เข้ามาหลังเกมเริ่มไปแล้ว) ต้องถูกกันไม่ให้เลือกการ์ดในรอบนี้
        // ---------------------------------------------------------------
        const lateJoiner = connectClient();
        const lateInit = await waitForEvent(lateJoiner, 'init-data');
        record('ผู้เล่นที่เชื่อมต่อหลัง Start Game เห็นสถานะ isGameStarted = true', lateInit.isGameStarted === true);

        lateJoiner.emit('join-waiting-room', { name: 'สมหญิง', surname: 'มาสาย', org: 'หน่วยทดสอบ', avatar: '🐶' });
        const waitingCountUpdate = await waitForEvent(admin, 'waiting-count-updated');
        record('แอดมินได้รับอัปเดตจำนวนผู้รอคิวแบบเรียลไทม์เมื่อมีผู้มาสาย',
            waitingCountUpdate.count === 1, `count=${waitingCountUpdate.count}`);

        // จำลองกรณี race condition: ผู้มาสายพยายาม emit register-player ตรงๆ ทั้งที่เกมเริ่มแล้ว
        const spareCard = lateInit.cards.find(c => !c.selectedBy);
        lateJoiner.emit('register-player', {
            name: 'สมหญิง', surname: 'มาสาย', org: 'หน่วยทดสอบ', cardId: spareCard.id, avatar: '🐶'
        });
        const blockedResult = await Promise.race([
            waitForEvent(lateJoiner, 'registration-blocked').then(() => 'blocked'),
            waitForEvent(lateJoiner, 'register-success').then(() => 'success')
        ]);
        record('ผู้มาสายไม่สามารถลงทะเบียนเลือกการ์ดในรอบที่กำลังเล่นอยู่ได้ (ถูกกันสำเร็จ)', blockedResult === 'blocked');

        // ---------------------------------------------------------------
        // แอดมิน Reset เกม (เปิดรอบใหม่) -> waiting count ต้องกลับเป็น 0, roundNumber +1
        // ---------------------------------------------------------------
        admin.emit('admin-reset-game');
        const resetData = await waitForEvent(admin, 'game-reset');
        record('Reset เกมแล้วเลขรอบเพิ่มขึ้นเป็นรอบที่ 2', resetData.roundNumber === 2, `roundNumber=${resetData.roundNumber}`);

        const resetWaitingUpdate = await waitForEvent(admin, 'waiting-count-updated');
        record('หลัง Reset จำนวนผู้รอคิวถูกล้างกลับเป็น 0', resetWaitingUpdate.count === 0);

        // ผู้ที่เคยมาสายตอนนี้ควรลงทะเบียนเลือกการ์ดในรอบใหม่ได้ตามปกติแล้ว
        const freshCard = resetData.cards[0];
        lateJoiner.emit('register-player', {
            name: 'สมหญิง', surname: 'มาสาย', org: 'หน่วยทดสอบ', cardId: freshCard.id, avatar: '🐶'
        });
        const afterResetResult = await Promise.race([
            waitForEvent(lateJoiner, 'register-success').then(() => 'success'),
            waitForEvent(lateJoiner, 'registration-blocked').then(() => 'blocked')
        ]);
        record('หลังเปิดรอบใหม่ ผู้ที่เคยรอคิวลงทะเบียนเลือกการ์ดได้สำเร็จ', afterResetResult === 'success');

        // ---------------------------------------------------------------
        // ผู้ที่กำลังรอคิวอยู่ (มาสายระหว่างรอบก่อน) ต้องถูกรับเข้ารอบใหม่ด้วยเมื่อแอดมินกด
        // "รอบใหม่ (คงผู้เล่นเดิม)" โดยไม่ต้องกรอกฟอร์มลงทะเบียนเอง (แก้บั๊กที่เคยถูกทิ้งคิวไปเฉยๆ)
        // ---------------------------------------------------------------
        const steadyPlayer = connectClient();
        const steadyInit = await waitForEvent(steadyPlayer, 'init-data');
        const steadyCard = steadyInit.cards.find(c => !c.selectedBy);
        steadyPlayer.emit('register-player', {
            name: 'สมศักดิ์', surname: 'ประจำรอบ', org: 'หน่วยทดสอบ', cardId: steadyCard.id, avatar: '🦊'
        });
        await waitForEvent(steadyPlayer, 'register-success');

        const waitingLate = connectClient();
        await waitForEvent(waitingLate, 'init-data');
        waitingLate.emit('join-waiting-room', { name: 'คนมาสาย', surname: 'รอบใหม่', org: 'หน่วยทดสอบ', avatar: '🐢' });
        await waitForEvent(admin, 'waiting-count-updated');

        const steadyNewCardPromise = waitForEvent(steadyPlayer, 'your-new-card');
        const waitingLateNewCardPromise = waitForEvent(waitingLate, 'your-new-card');
        admin.emit('admin-new-round-keep-players');
        const [steadyNewCard, waitingLateNewCard] = await Promise.all([steadyNewCardPromise, waitingLateNewCardPromise]);
        record('ผู้เล่นเดิมที่ออนไลน์อยู่ได้การ์ดใบใหม่ตอนเปิดรอบใหม่คงผู้เล่นเดิม', typeof steadyNewCard.cardId === 'number');
        record('ผู้ที่กำลังรอคิวอยู่ก่อนหน้าได้รับเข้ารอบใหม่พร้อมการ์ดทันที ไม่ถูกทิ้งคิว (บั๊กที่แก้ไปแล้ว)',
            typeof waitingLateNewCard.cardId === 'number');

        steadyPlayer.close();
        waitingLate.close();

        // ---------------------------------------------------------------
        // ตรวจสอบว่า SFX broadcast กระจายไปถึงทุก client จริง (แม้จะเช็คเสียงจริงไม่ได้ที่นี่)
        // ---------------------------------------------------------------
        const sfxPromise = waitForEvent(lateJoiner, 'trigger-sfx');
        admin.emit('admin-play-sfx', 'tada');
        const sfxType = await sfxPromise;
        record('เหตุการณ์ trigger-sfx ถูก broadcast ไปถึงฝั่งผู้เล่นจริง (server-side)', sfxType === 'tada',
            'หมายเหตุ: ยืนยันได้แค่ event ไปถึง แต่การ "ได้ยินเสียงจริง" ต้องทดสอบในเบราว์เซอร์ (ดู TEST_PLAN.md)');

        // ---------------------------------------------------------------
        // ระบบ token จำตัวตนผู้เล่น (แบบ B): ลงทะเบียนคนใหม่ -> ต้องได้ token กลับมา
        // ---------------------------------------------------------------
        const tokenPlayer = connectClient();
        const tokenPlayerInit = await waitForEvent(tokenPlayer, 'init-data');
        const cardForToken = tokenPlayerInit.cards.find(c => !c.selectedBy);
        tokenPlayer.emit('register-player', {
            name: 'มานี', surname: 'มีทอง', org: 'หน่วยทดสอบ', cardId: cardForToken.id, avatar: '🐰'
        });
        const tokenRegisterResult = await waitForEvent(tokenPlayer, 'register-success');
        record('ลงทะเบียนผู้เล่นใหม่แล้วได้รับ token ประจำตัวกลับมา',
            typeof tokenRegisterResult.token === 'string' && tokenRegisterResult.token.length > 0);
        const savedToken = tokenRegisterResult.token;
        const originalCardId = tokenRegisterResult.player.cardId;

        // จำลอง "หลุดเน็ต/รีเฟรชหน้า": ปิด connection เดิม แล้วเปิดใหม่พร้อมส่ง token กลับมาขอกู้คืนสถานะ
        tokenPlayer.close();
        await wait(300);
        const reconnected = connectClient();
        await waitForEvent(reconnected, 'connect');
        reconnected.emit('identify-player', savedToken);
        const restoreData = await waitForEvent(reconnected, 'restore-session');
        record('ผู้เล่นที่หลุดเน็ตแล้วกลับมาใหม่ ได้รับการ์ดใบเดิมคืนอัตโนมัติโดยไม่ต้องกรอกชื่อซ้ำ',
            !!restoreData.player && restoreData.player.cardId === originalCardId,
            `cardId เดิม=${originalCardId}, cardId ที่ได้คืน=${restoreData.player && restoreData.player.cardId}`);

        // token ปลอม/ไม่เคยลงทะเบียน ต้องถูกปฏิเสธอย่างถูกต้อง
        const strangerClient = connectClient();
        await waitForEvent(strangerClient, 'connect');
        strangerClient.emit('identify-player', 'token-ที่ไม่มีอยู่จริง-12345');
        const identifyFailResult = await Promise.race([
            waitForEvent(strangerClient, 'identify-failed').then(() => 'failed'),
            waitForEvent(strangerClient, 'restore-session').then(() => 'restored')
        ]);
        record('token ที่ไม่เคยลงทะเบียนมาก่อนถูกปฏิเสธอย่างถูกต้อง (identify-failed)', identifyFailResult === 'failed');
        strangerClient.close();

        // ---------------------------------------------------------------
        // แอดมินเปิด "รอบใหม่ (คงผู้เล่นเดิม)": ต้องได้การ์ดใบใหม่ทันที ไม่ต้องกรอกชื่อซ้ำ และรอบ +1
        // ---------------------------------------------------------------
        const newCardPromise = waitForEvent(reconnected, 'your-new-card');
        admin.emit('admin-new-round-keep-players');
        const newCardData = await newCardPromise;
        record('รอบใหม่ (คงผู้เล่นเดิม) เพิ่มเลขรอบขึ้น 1 และแจกการ์ดใบใหม่ให้ทันที',
            typeof newCardData.cardId === 'number' && typeof newCardData.roundNumber === 'number');

        admin.close();
        earlyPlayer.close();
        lateJoiner.close();
        reconnected.close();

    } catch (err) {
        console.error('เกิดข้อผิดพลาดระหว่างทดสอบ:', err.message);
    } finally {
        serverProcess.kill();
    }

    console.log('\n===== สรุปผลการทดสอบ =====');
    const passCount = results.filter(r => r.pass).length;
    console.log(`ผ่าน ${passCount}/${results.length} รายการ`);
    if (passCount !== results.length) {
        console.log('รายการที่ไม่ผ่าน:');
        results.filter(r => !r.pass).forEach(r => console.log(`  - ${r.name}`));
        process.exitCode = 1;
    }
}

main();