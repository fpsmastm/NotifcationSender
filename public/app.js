const enableButton = document.getElementById('enable');
const sendButton = document.getElementById('send');
const statusEl = document.getElementById('status');
const nameInput = document.getElementById('name');
const messageInput = document.getElementById('message');
const imageInput = document.getElementById('image');
const preview = document.getElementById('preview');
const feed = document.getElementById('feed');

const SUBSCRIPTION_FLAG_KEY = 'notificationsOptedIn';

let imageDataUrl = '';
let registration = null;

const base64ToUint8Array = (base64) => {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(normalized);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
};

const updateStatus = (text) => {
  statusEl.textContent = text;
};

const addFeedItem = (entry) => {
  const li = document.createElement('li');
  li.className = 'feed-item';

  const heading = document.createElement('strong');
  heading.textContent = entry.sender;
  li.appendChild(heading);

  if (entry.text) {
    const message = document.createElement('p');
    message.textContent = entry.text;
    li.appendChild(message);
  }

  if (entry.imageDataUrl) {
    const img = document.createElement('img');
    img.src = entry.imageDataUrl;
    img.alt = `Image sent by ${entry.sender}`;
    li.appendChild(img);
  }

  const date = document.createElement('small');
  date.textContent = new Date(entry.createdAt).toLocaleString();
  li.appendChild(date);

  feed.prepend(li);
};

const showForegroundNotification = (entry) => {
  if (Notification.permission !== 'granted') return;

  registration?.showNotification(`${entry.sender} sent a notification`, {
    body: entry.text || 'Sent an image',
    image: entry.imageDataUrl || undefined,
    icon: entry.imageDataUrl || undefined,
    data: { url: '/' }
  });
};

const connectRealtime = () => {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/realtime`);

  socket.onopen = () => {
    updateStatus('Connected. Notifications can be sent to all subscribed users.');
  };

  socket.onmessage = (event) => {
    const { type, payload } = JSON.parse(event.data);

    if (type === 'history') {
      payload.forEach(addFeedItem);
      return;
    }

    if (type === 'message') {
      addFeedItem(payload);
      if (document.visibilityState === 'visible') {
        showForegroundNotification(payload);
      }
    }
  };

  socket.onclose = () => {
    updateStatus('Realtime connection lost. Reconnecting...');
    setTimeout(connectRealtime, 1500);
  };
};

const postSubscriptionToServer = async (subscription) => {
  await fetch('/api/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription })
  });
};

const subscribeToPush = async () => {
  const config = await fetch('/api/config').then((res) => res.json());
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64ToUint8Array(config.vapidPublicKey)
  });

  await postSubscriptionToServer(subscription);
  localStorage.setItem(SUBSCRIPTION_FLAG_KEY, 'true');
};

const ensurePermanentSubscription = async () => {
  if (!registration || Notification.permission !== 'granted') {
    return;
  }

  const existingSubscription = await registration.pushManager.getSubscription();

  if (existingSubscription) {
    await postSubscriptionToServer(existingSubscription);
    localStorage.setItem(SUBSCRIPTION_FLAG_KEY, 'true');
    return;
  }

  if (localStorage.getItem(SUBSCRIPTION_FLAG_KEY) === 'true') {
    await subscribeToPush();
  }
};

const enableNotifications = async () => {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    updateStatus('This browser does not support service workers/push notifications.');
    return;
  }

  registration = await navigator.serviceWorker.register('/sw.js');
  const permission = await Notification.requestPermission();

  if (permission !== 'granted') {
    updateStatus('Notifications were blocked.');
    return;
  }

  await ensurePermanentSubscription();
  updateStatus('Subscribed permanently on this browser. You will keep receiving notifications.');
};

const sendMessage = async () => {
  const sender = nameInput.value.trim() || 'Anonymous';
  const text = messageInput.value.trim();

  if (!text && !imageDataUrl) {
    updateStatus('Type a message or attach an image before sending.');
    return;
  }

  const response = await fetch('/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender, text, imageDataUrl })
  });

  if (!response.ok) {
    updateStatus('Unable to send notification right now.');
    return;
  }

  messageInput.value = '';
  imageInput.value = '';
  imageDataUrl = '';
  preview.classList.add('hidden');
  updateStatus('Notification sent to everyone who allowed notifications.');
};

imageInput.addEventListener('change', () => {
  const file = imageInput.files?.[0];
  if (!file) {
    imageDataUrl = '';
    preview.classList.add('hidden');
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    imageDataUrl = String(reader.result);
    preview.src = imageDataUrl;
    preview.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
});

enableButton.addEventListener('click', async () => {
  try {
    await enableNotifications();
  } catch {
    updateStatus('Failed to enable notifications.');
  }
});

sendButton.addEventListener('click', async () => {
  try {
    await sendMessage();
  } catch {
    updateStatus('Failed to send message.');
  }
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(async (reg) => {
    registration = reg;

    if (Notification.permission === 'granted') {
      await ensurePermanentSubscription();
      updateStatus('Already subscribed on this browser.');
    }
  }).catch(() => {
    updateStatus('Service worker registration failed.');
  });
}

connectRealtime();
