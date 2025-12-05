const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 5000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

let codes = [];

// Helper functions for code extraction
function extractCode(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  
  for (const line of lines) {
    if (/^[A-Z0-9]{4,20}$/.test(line)) {
      if (line.length >= 6 || /[A-Z]{3}/.test(line)) {
        return line;
      }
    }
  }
  
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].toLowerCase().includes('code')) {
      const nextLine = lines[i + 1];
      if (/^[A-Z0-9]{4,20}$/.test(nextLine)) {
        return nextLine;
      }
    }
  }
  
  return null;
}

function extractWager(text) {
  const match = text.match(/\$?([\d,]+(?:\.\d+)?)\s*wager\s*requirement/i);
  return match ? '$' + match[1] : 'Unknown';
}

function extractDeadline(text) {
  const firstMatch = text.match(/first\s+([\d,]+)/i);
  if (firstMatch) return `First ${firstMatch[1]}`;
  
  const timeMatch = text.match(/(\d+)\s*(hour|day|minute)s?/i);
  if (timeMatch) return `${timeMatch[1]} ${timeMatch[2]}s`;
  
  return 'Limited time';
}

function extractAmount(text) {
  const match = text.match(/\$?([\d,]+(?:\.\d+)?)\s*for\s*the\s*first/i);
  return match ? '$' + match[1] : 'N/A';
}

// Receive message from Telegram bot
app.post('/api/telegram-message', (req, res) => {
  const { message } = req.body;
  
  if (!message) {
    return res.status(400).json({ error: 'Message required' });
  }
  
  const code = extractCode(message);
  
  if (code) {
    const exists = codes.find(c => c.code === code);
    if (!exists) {
      const newCode = {
        id: Date.now(),
        code,
        message,
        wager: extractWager(message),
        deadline: extractDeadline(message),
        amount: extractAmount(message),
        timestamp: new Date().toISOString(),
        claimed: false,
        claimedAt: null,
        rejectionReason: null
      };
      codes.unshift(newCode);
      console.log(`✅ NEW CODE DETECTED: ${code} | Amount: ${newCode.amount} | Wager: ${newCode.wager}`);
    }
  }
  
  res.json({ success: true, codeDetected: !!code });
});

// Add code
app.post('/api/code', (req, res) => {
  const { code, message, wager, deadline, amount } = req.body;
  
  if (!code) {
    return res.status(400).json({ error: 'Code required' });
  }

  const exists = codes.find(c => c.code === code);
  if (!exists) {
    const newCode = {
      id: Date.now(),
      code,
      message: message || '',
      wager: wager || 'Unknown',
      deadline: deadline || 'Limited time',
      amount: amount || 'N/A',
      timestamp: new Date().toISOString(),
      claimed: false,
      claimedAt: null
    };
    codes.unshift(newCode);
    console.log(`✅ New code: ${code} | Wager: ${wager} | Deadline: ${deadline}`);
  }

  res.json({ success: true });
});

// Mark code as claimed or rejected
app.post('/api/code/claim', (req, res) => {
  const { code, success, reason } = req.body;
  const codeObj = codes.find(c => c.code === code);
  
  if (codeObj) {
    if (success) {
      codeObj.claimed = true;
      codeObj.claimedAt = new Date().toISOString();
      codeObj.rejectionReason = null;
      console.log(`✅ CODE CLAIMED: ${code}`);
    } else {
      codeObj.claimed = false;
      codeObj.rejectionReason = reason || 'Unknown error';
      console.log(`❌ CODE REJECTED: ${code} - ${codeObj.rejectionReason}`);
    }
  }
  
  res.json({ success: true });
});

// Get all codes
app.get('/api/codes', (req, res) => {
  res.json(codes);
});

// Clear codes
app.delete('/api/codes', (req, res) => {
  codes = [];
  res.json({ success: true });
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/', (req, res) => {
  res.redirect('/dashboard');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎰 Dashboard: http://0.0.0.0:${PORT}/dashboard`);
});
