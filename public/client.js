const socket = io();

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const logsDiv = document.getElementById('logs');
const stateBadge = document.getElementById('stateBadge');

startBtn.addEventListener('click', () => {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const courseName = document.getElementById('courseName').value;

    if (!username || !password) {
        alert('Please enter both username and password.');
        return;
    }

    startBtn.disabled = true;
    startBtn.innerText = 'Bot Running...';
    stopBtn.style.display = 'block';
    
    addLog('🚀 Connecting to automation engine...', 'system');
    
    socket.emit('start-bot', { username, password, courseName });
});

stopBtn.addEventListener('click', () => {
    socket.emit('stop-bot');
    addLog('🛑 Stop request sent...', 'system');
    resetUI();
});

function resetUI() {
    startBtn.disabled = false;
    startBtn.innerText = 'Launch Automation';
    stopBtn.style.display = 'none';
    stateBadge.innerText = 'Stopped';
}

socket.on('bot-finished', () => {
    resetUI();
});

socket.on('log', (msg) => {
    addLog(msg);
});

socket.on('state', (state) => {
    stateBadge.innerText = state;
    addLog(`System State changed to: ${state}`, 'state');
});

function addLog(msg, type = '') {
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerText = msg;
    logsDiv.appendChild(entry);
    logsDiv.scrollTop = logsDiv.scrollHeight;
}
