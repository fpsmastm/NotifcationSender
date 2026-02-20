const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const webpush = require('web-push');
const { WebSocketServer } = require('ws');

const app = express();
const port = process.env.PORT || 3000;
const subscriptionsFile = path.join(__dirname, 'data', 'subscriptions.json');

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const getVapidKeys = () => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;

  if (publicKey && privateKey) {
    return { publicKey, privateKey, generated: false };
  }

  const generatedKeys = webpush.generateVAPIDKeys();
  return { ...generatedKeys, generated: true };
};

const readSubscriptionsFromDisk = () => {
  try {
    if (!fs.existsSync(subscriptionsFile)) {
      return [];
    }

    const raw = fs.readFileSync(subscriptionsFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeSubscriptionsToDisk = (subscriptionsMap) => {
  const allSubscriptions = [...subscriptionsMap.values()];
  const targetDir = path.dirname(subscriptionsFile);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  fs.writeFileSync(subscriptionsFile, JSON.stringify(allSubscriptions, null, 2), 'utf8');
};

const vapidKeys = getVapidKeys();
webpush.setVapidDetails('mailto:admin@example.com', vapidKeys.publicKey, vapidKeys.privateKey);

if (vapidKeys.generated) {
  // eslint-disable-next-line no-console
  console.warn(
    '[warn] VAPID keys were auto-generated for this process. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in your host for stable subscriptions across restarts.'
  );
}

const pushSubscriptions = new Map(
  readSubscriptionsFromDisk()
    .filter((subscription) => subscription?.endpoint)
    .map((subscription) => [subscription.endpoint, subscription])
);

const recentMessages = [];
const wss = new WebSocketServer({ noServer: true });

const createMessage = ({ sender, text, imageDataUrl }) => ({
  id: crypto.randomUUID(),
  sender: sender || 'Anonymous',
  text: text || '',
  imageDataUrl: imageDataUrl || '',
  createdAt: new Date().toISOString()
});

const toNotificationPayload = (message) => JSON.stringify({
  title: `${message.sender} sent a notification`,
  body: message.text || 'Sent an image',
  image: message.imageDataUrl || undefined,
  data: {
    url: '/',
    message
  }
});

const broadcastRealtime = (message) => {
  const encoded = JSON.stringify({ type: 'message', payload: message });
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(encoded);
    }
  });
};

const sendPushToSubscribers = async (message) => {
  const payload = toNotificationPayload(message);
  const sendTasks = [];
  let removedAny = false;

  pushSubscriptions.forEach((subscription, key) => {
    const task = webpush.sendNotification(subscription, payload).catch(() => {
      pushSubscriptions.delete(key);
      removedAny = true;
    });
    sendTasks.push(task);
  });

  await Promise.all(sendTasks);

  if (removedAny) {
    writeSubscriptionsToDisk(pushSubscriptions);
  }
};

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, subscribers: pushSubscriptions.size, messages: recentMessages.length });
});

app.get('/api/config', (_req, res) => {
  res.json({ vapidPublicKey: vapidKeys.publicKey });
});

app.get('/api/messages', (_req, res) => {
  res.json({ messages: recentMessages.slice(-50) });
});

app.post('/api/subscribe', (req, res) => {
  const subscription = req.body?.subscription;

  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription payload.' });
  }

  pushSubscriptions.set(subscription.endpoint, subscription);
  writeSubscriptionsToDisk(pushSubscriptions);
  return res.status(201).json({ success: true, totalSubscribers: pushSubscriptions.size });
});

app.post('/api/send', async (req, res) => {
  const { sender, text, imageDataUrl } = req.body || {};

  if (!text && !imageDataUrl) {
    return res.status(400).json({ error: 'Please include text or an image.' });
  }

  const message = createMessage({ sender, text, imageDataUrl });
  recentMessages.push(message);
  if (recentMessages.length > 100) {
    recentMessages.shift();
  }

  broadcastRealtime(message);
  await sendPushToSubscribers(message);

  return res.status(201).json({ success: true, message });
});

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Notification server running on http://localhost:${port}`);
});

server.on('upgrade', (request, socket, head) => {
  if (request.url !== '/realtime') {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'history', payload: recentMessages.slice(-50) }));
});
