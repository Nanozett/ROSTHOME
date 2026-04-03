import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const API_BASE = '/api';
let currentUserId = null;
let devicesData = [];
let currentRoomFilter = 'all';
let currentDeviceId = null;

// 3D переменные
let scene, camera, renderer, labelRenderer, controls;
let deviceMeshes = new Map();
let raycaster, mouse;
let dragObject = null;
let dragPlane = null;
let dragOffset = new THREE.Vector3();

// Таймеры и AI
let monitoringInterval = null;
let ironOnStartTime = null;
let scheduleCheckInterval = null;

// ========= ДОСТУПНОСТЬ =========
let isAccessibilityMode = false;

function toggleAccessibilityMode() {
  isAccessibilityMode = !isAccessibilityMode;
  if (isAccessibilityMode) {
    document.body.classList.add('accessibility-mode');
    localStorage.setItem('accessibilityMode', 'on');
    showNotification('Режим для слабовидящих включён: крупный шрифт, высокий контраст', 'info');
  } else {
    document.body.classList.remove('accessibility-mode');
    localStorage.setItem('accessibilityMode', 'off');
    showNotification('Обычный режим восстановлен', 'info');
  }
}

function loadAccessibilityMode() {
  const saved = localStorage.getItem('accessibilityMode');
  if (saved === 'on') {
    isAccessibilityMode = true;
    document.body.classList.add('accessibility-mode');
  }
}

function speakText(text) {
  if (!window.speechSynthesis) {
    console.warn('SpeechSynthesis не поддерживается');
    return;
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ru-RU';
  utterance.rate = 0.9;
  utterance.pitch = 1;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

// --- Вспомогательные функции ---
function showNotification(message, type = 'warning') {
  const area = document.getElementById('notification-area');
  if (!area) return;
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.innerHTML = `<span>${type === 'warning' ? '⚠️' : 'ℹ️'}</span> ${message}`;
  area.appendChild(notification);
  setTimeout(() => notification.remove(), 5000);
}

function generateId() {
  return 'dev_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

// --- API вызовы ---
async function apiRequest(endpoint, method, body = null) {
  const headers = {
    'Content-Type': 'application/json',
    'x-user-id': currentUserId
  };
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(`${API_BASE}${endpoint}`, options);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Ошибка запроса');
  }
  return response.json();
}

async function loadDevices() {
  try {
    const devices = await apiRequest('/devices', 'GET');
    devicesData = devices;
    renderDevices(currentRoomFilter);
    if (scene) rebuild3DScene();
    if (devicesData.length > 0) selectDevice(devicesData[0].id);
    else updateInfoPanel(null);
    return devices;
  } catch (err) {
    console.error(err);
    showNotification('Ошибка загрузки устройств', 'warning');
    return [];
  }
}

async function saveDeviceToServer(device) {
  try {
    const updateData = {
      name: device.name,
      room: device.room,
      type: device.type,
      status: device.status ? 1 : 0,
      pos_x: device.pos.x,
      pos_y: device.pos.y,
      pos_z: device.pos.z,
      manufacturer: device.manufacturer,
      state: device.state,
      battery: device.battery,
      target_temp: device.targetTemp,
      connected_device: device.connectedDevice,
      target_room: device.targetRoom
    };
    await apiRequest(`/devices/${device.id}`, 'PUT', updateData);
  } catch (err) {
    console.error('Ошибка сохранения устройства:', err);
    showNotification(`Не удалось сохранить изменения для ${device.name}`, 'warning');
  }
}

async function addDeviceToServer(deviceData) {
  try {
    const newId = generateId();
    const newDevice = {
      id: newId,
      name: deviceData.name,
      room: deviceData.room,
      type: deviceData.type,
      status: deviceData.status || false,
      pos: { x: (Math.random() - 0.5) * 5, y: 0.5, z: (Math.random() - 0.5) * 5 },
      manufacturer: deviceData.manufacturer,
      state: deviceData.status ? 'включено' : 'выключено',
      battery: deviceData.type === 'Робот-пылесос' ? 100 : (deviceData.type === 'Стиральная машина' ? null : null),
      targetTemp: deviceData.type === 'Кондиционер' ? 22 : null,
      connectedDevice: deviceData.type === 'Розетка' ? 'Утюг' : null,
      targetRoom: null,
      program: deviceData.type === 'Стиральная машина' ? 'Стандартная' : null
    };
    if (newDevice.type === 'Кондиционер') {
      newDevice.temperature = 22;
      newDevice.targetTemp = 22;
      newDevice.state = newDevice.status ? 'охлаждение 22°C' : 'выключен';
    }
    if (newDevice.type === 'Розетка') {
      newDevice.connectedDevice = 'Утюг';
      newDevice.state = newDevice.status ? `питает ${newDevice.connectedDevice}` : `выключена (${newDevice.connectedDevice} не питается)`;
    }
    if (newDevice.type === 'Стиральная машина') {
      newDevice.state = newDevice.status ? 'стирка' : 'выключена';
    }
    await apiRequest('/devices', 'POST', {
      device_id: newId,
      name: newDevice.name,
      room: newDevice.room,
      type: newDevice.type,
      status: newDevice.status ? 1 : 0,
      pos: newDevice.pos,
      manufacturer: newDevice.manufacturer,
      state: newDevice.state,
      battery: newDevice.battery,
      targetTemp: newDevice.targetTemp,
      connectedDevice: newDevice.connectedDevice,
      targetRoom: newDevice.targetRoom,
      program: newDevice.program
    });
    devicesData.push(newDevice);
    renderDevices(currentRoomFilter);
    if (scene) addDeviceTo3D(newDevice);
    showNotification(`Устройство "${deviceData.name}" добавлено`, 'info');
  } catch (err) {
    console.error(err);
    showNotification('Ошибка добавления устройства', 'warning');
  }
}

async function deleteDeviceFromServer(deviceId) {
  try {
    await apiRequest(`/devices/${deviceId}`, 'DELETE');
    const device = devicesData.find(d => d.id === deviceId);
    if (device) {
      stopDeviceTimers(deviceId);
      if (deviceMeshes.has(deviceId)) {
        const entry = deviceMeshes.get(deviceId);
        scene.remove(entry.mesh);
        scene.remove(entry.label);
        deviceMeshes.delete(deviceId);
      }
      devicesData = devicesData.filter(d => d.id !== deviceId);
      if (currentDeviceId === deviceId) {
        currentDeviceId = null;
        updateInfoPanel(null);
      }
      renderDevices(currentRoomFilter);
      showNotification(`Устройство "${device.name}" удалено`, 'info');
    }
    deleteSchedulesForDevice(deviceId);
  } catch (err) {
    console.error(err);
    showNotification('Ошибка удаления устройства', 'warning');
  }
}

// --- Работа с профилем ---
async function loadUserProfile() {
  try {
    const profile = await apiRequest('/profile', 'GET');
    document.getElementById('avatar-display').textContent = profile.avatar || '👤';
    document.getElementById('username-display').textContent = profile.nickname || profile.username;
    return profile;
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function saveProfileSettings(avatar, nickname) {
  try {
    await apiRequest('/profile', 'PUT', { avatar, nickname });
    document.getElementById('avatar-display').textContent = avatar;
    document.getElementById('username-display').textContent = nickname;
    showNotification('Профиль обновлён', 'info');
  } catch (err) {
    console.error(err);
    showNotification('Ошибка сохранения профиля', 'warning');
  }
}

// --- Авторизация ---
async function login(username, password) {
  try {
    const response = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error);
    }
    const user = await response.json();
    currentUserId = user.id;
    localStorage.setItem('currentUserId', currentUserId);
    await loadUserProfile();
    await loadDevices();
    startAIMonitoring();
    startScheduleChecker();
    return true;
  } catch (err) {
    alert(err.message);
    return false;
  }
}

async function register(username, password) {
  try {
    const response = await fetch(`${API_BASE}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error);
    }
    const user = await response.json();
    currentUserId = user.id;
    localStorage.setItem('currentUserId', currentUserId);
    await loadUserProfile();
    await loadDevices();
    startAIMonitoring();
    startScheduleChecker();
    return true;
  } catch (err) {
    alert(err.message);
    return false;
  }
}

function showAuthModal() {
  const modal = document.createElement('div');
  modal.className = 'auth-modal';
  modal.innerHTML = `
    <div class="auth-container">
      <h2>🏠 Умный дом</h2>
      <div id="auth-form">
        <input type="text" id="username" placeholder="Имя пользователя">
        <input type="password" id="password" placeholder="Пароль">
        <button id="login-btn">Вход</button>
        <div class="auth-switch">
          Нет аккаунта? <span id="switch-to-reg">Зарегистрироваться</span>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const switchToReg = modal.querySelector('#switch-to-reg');
  const loginBtn = modal.querySelector('#login-btn');
  const usernameInput = modal.querySelector('#username');
  const passwordInput = modal.querySelector('#password');

  let isRegisterMode = false;
  switchToReg.addEventListener('click', () => {
    isRegisterMode = !isRegisterMode;
    loginBtn.textContent = isRegisterMode ? 'Регистрация' : 'Вход';
    switchToReg.textContent = isRegisterMode ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться';
  });

  loginBtn.addEventListener('click', async () => {
    const username = usernameInput.value.trim();
    const password = passwordInput.value.trim();
    if (!username || !password) {
      alert('Введите имя и пароль');
      return;
    }
    let success;
    if (isRegisterMode) success = await register(username, password);
    else success = await login(username, password);
    if (success) {
      modal.remove();
      initUIAfterAuth();
    }
  });
}

// --- AI Мониторинг ---
function startAIMonitoring() {
  if (monitoringInterval) clearInterval(monitoringInterval);
  monitoringInterval = setInterval(() => {
    const socket = devicesData.find(d => d.type === 'Розетка' && d.connectedDevice === 'Утюг');
    if (!socket) return;

    if (socket.status) {
      if (ironOnStartTime === null) ironOnStartTime = Date.now();
      const elapsedSeconds = (Date.now() - ironOnStartTime) / 1000;
      if (elapsedSeconds >= 15) {
        showNotification('🔌 Утюг включён более 15 секунд! Автоматически выключаю для безопасности.', 'warning');
        toggleDeviceStatus(socket.id);
        ironOnStartTime = null;
        return;
      }
      if (Math.random() < 0.02) {
        const faults = [
          { msg: '⚠️ Обнаружен перегрев утюга! Выключаю для предотвращения пожара.', type: 'warning' },
          { msg: '⚡ Неисправность проводки в розетке! Отключаю питание.', type: 'warning' }
        ];
        const fault = faults[Math.floor(Math.random() * faults.length)];
        showNotification(fault.msg, fault.type);
        toggleDeviceStatus(socket.id);
        ironOnStartTime = null;
      }
    } else {
      ironOnStartTime = null;
    }
  }, 2000);
}

function stopDeviceTimers(deviceId) { }

function updateUIForDevice(deviceId) {
  const device = devicesData.find(d => d.id === deviceId);
  if (!device) return;
  renderDevices(currentRoomFilter);
  if (currentDeviceId === deviceId) updateInfoPanel(deviceId);
  if (deviceMeshes.has(deviceId)) updateDevice3DVisual(deviceId);
}

async function toggleDeviceStatus(deviceId) {
  const device = devicesData.find(d => d.id === deviceId);
  if (!device) return;

  if (device.type === 'Робот-пылесос') {
    if (!device.status && device.battery === 0) {
      alert('Пылесос разряжен, поставьте на зарядку.');
      return;
    }
    if (device.status) {
      device.status = false;
      device.state = device.targetRoom ? `готов к уборке в ${device.targetRoom}` : 'на базе';
    } else {
      if (!device.targetRoom) {
        alert('Выберите комнату для уборки в выпадающем списке.');
        return;
      }
      if (device.battery <= 0) {
        alert('Пылесос разряжен, поставьте на зарядку.');
        return;
      }
      device.status = true;
      device.state = `уборка ${device.targetRoom} (${device.battery}%)`;
    }
    await saveDeviceToServer(device);
    updateUIForDevice(device.id);
    return;
  }

  if (device.type === 'Розетка') {
    device.status = !device.status;
    if (device.status) {
      device.state = `питает ${device.connectedDevice}`;
      if (device.connectedDevice === 'Утюг') ironOnStartTime = null;
    } else {
      device.state = `выключена (${device.connectedDevice} не питается)`;
    }
    await saveDeviceToServer(device);
    updateUIForDevice(device.id);
    return;
  }

  if (device.type === 'Кондиционер') {
    device.status = !device.status;
    if (device.status) {
      device.temperature = device.targetTemp;
      if (device.targetTemp < 20) device.state = `охлаждение до ${device.targetTemp}°C`;
      else if (device.targetTemp > 24) device.state = `обогрев до ${device.targetTemp}°C`;
      else device.state = `поддержание ${device.targetTemp}°C`;
    } else {
      device.state = `выключен (установлена ${device.targetTemp}°C)`;
    }
    await saveDeviceToServer(device);
    updateUIForDevice(device.id);
    return;
  }

  if (device.type === 'Стиральная машина') {
    device.status = !device.status;
    device.state = device.status ? 'стирка' : 'выключена';
    await saveDeviceToServer(device);
    updateUIForDevice(device.id);
    return;
  }

  device.status = !device.status;
  device.state = device.status ? 'включено' : 'выключено';
  await saveDeviceToServer(device);
  updateUIForDevice(device.id);
}

// --- Рендер списка устройств ---
function renderDevices(roomFilter = 'all') {
  const container = document.getElementById('devices-container');
  if (!container) return;
  let filtered = [...devicesData];
  if (roomFilter !== 'all') filtered = filtered.filter(dev => dev.room === roomFilter);
  if (filtered.length === 0) {
    container.innerHTML = '<div class="loading">Нет устройств в этой комнате</div>';
    return;
  }

  const roomsList = ['Гостиная', 'Кухня', 'Спальня', 'Кабинет'];
  const devicesList = ['Утюг', 'Фен', 'Зарядное устройство', 'Электрочайник', 'Настольная лампа'];

  const html = filtered.map(device => {
    let controlsHtml = '';
    if (device.type === 'Робот-пылесос') {
      controlsHtml = `
        <select class="room-select" data-id="${device.id}" data-action="setRoom" ${device.status ? 'disabled' : ''}>
          <option value="">-- Направить в комнату --</option>
          ${roomsList.map(room => `<option value="${room}" ${device.targetRoom === room ? 'selected' : ''}>${room}</option>`).join('')}
        </select>
      `;
    } else if (device.type === 'Кондиционер') {
      controlsHtml = `
        <div class="temp-control">
          <span>🌡️ ${device.temperature}°C</span>
          <input type="range" min="16" max="30" step="1" value="${device.targetTemp}" class="temp-slider" data-id="${device.id}" ${device.status ? '' : 'disabled'}>
        </div>
      `;
    } else if (device.type === 'Розетка') {
      controlsHtml = `
        <select class="device-select" data-id="${device.id}" data-action="setDevice">
          ${devicesList.map(dev => `<option value="${dev}" ${device.connectedDevice === dev ? 'selected' : ''}>${dev}</option>`).join('')}
        </select>
      `;
    }

    const showScheduleBtn = (device.type === 'Робот-пылесос' || device.type === 'Стиральная машина');
    const scheduleBtnHtml = showScheduleBtn ? `<button class="schedule-btn" data-id="${device.id}" data-action="schedule">🗓️</button>` : '';

    return `
      <div class="device-card ${currentDeviceId === device.id ? 'selected' : ''}" data-id="${device.id}">
        <div class="device-info">
          <div class="device-name">
            ${device.name}
            <span class="device-type">${device.type}</span>
          </div>
          <div class="device-room">${device.room}</div>
          <div style="margin-top: 8px;">
            <span class="status-badge ${device.status ? 'on' : 'off'}"></span>
            <span style="font-size: 0.8rem; margin-left: 6px;">${device.status ? 'Вкл' : 'Выкл'}</span>
          </div>
          <div class="device-details">
            <span>🏭 ${device.manufacturer}</span>
            ${device.battery !== null ? `<span>🔋 ${device.battery}%</span>` : ''}
            <span>📌 ${device.state}</span>
          </div>
          ${controlsHtml}
        </div>
        <div class="button-group">
          ${device.type === 'Робот-пылесос' ? `<button class="charge-btn" data-id="${device.id}" data-action="charge">⚡</button>` : ''}
          <button class="toggle-btn ${device.status ? 'btn-on' : 'btn-off'}" data-id="${device.id}" data-action="toggle">${device.status ? '🔘' : '⚪'}</button>
          ${scheduleBtnHtml}
          <button class="delete-btn" data-id="${device.id}" data-action="delete">🗑️</button>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
  attachEvents();
}

function attachEvents() {
  document.querySelectorAll('.device-card').forEach(card => {
    const devId = card.getAttribute('data-id');
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('toggle-btn') || e.target.classList.contains('charge-btn') ||
        e.target.classList.contains('room-select') || e.target.classList.contains('device-select') ||
        e.target.classList.contains('temp-slider') || e.target.classList.contains('delete-btn') ||
        e.target.classList.contains('schedule-btn')) return;
      selectDevice(devId);
    });

    const toggleBtn = card.querySelector('.toggle-btn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = toggleBtn.getAttribute('data-id');
        await toggleDeviceStatus(id);
        if (currentDeviceId === id) updateInfoPanel(id);
      });
    }

    const chargeBtn = card.querySelector('.charge-btn');
    if (chargeBtn) {
      chargeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = chargeBtn.getAttribute('data-id');
        const device = devicesData.find(d => d.id === id);
        if (device && device.type === 'Робот-пылесос') {
          if (device.status) {
            alert('Нельзя заряжать во время уборки. Сначала выключите пылесос.');
            return;
          }
          device.battery = 100;
          device.state = device.targetRoom ? `готов к уборке в ${device.targetRoom}` : 'на базе';
          await saveDeviceToServer(device);
          updateUIForDevice(id);
          showNotification(`${device.name} заряжен до 100%`, 'info');
        }
      });
    }

    const deleteBtn = card.querySelector('.delete-btn');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = deleteBtn.getAttribute('data-id');
        if (confirm('Удалить устройство?')) await deleteDeviceFromServer(id);
      });
    }

    const scheduleBtn = card.querySelector('.schedule-btn');
    if (scheduleBtn) {
      scheduleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const id = scheduleBtn.getAttribute('data-id');
        openScheduleModal(id);
      });
    }

    const roomSelect = card.querySelector('.room-select');
    if (roomSelect) {
      roomSelect.addEventListener('change', async (e) => {
        e.stopPropagation();
        const id = roomSelect.getAttribute('data-id');
        const selectedRoom = roomSelect.value;
        const device = devicesData.find(d => d.id === id);
        if (device && device.type === 'Робот-пылесос') {
          device.targetRoom = selectedRoom || null;
          if (device.status && device.targetRoom) {
            device.state = `уборка ${device.targetRoom} (${device.battery}%)`;
          } else if (!device.status) {
            device.state = device.targetRoom ? `готов к уборке в ${device.targetRoom}` : 'на базе';
          }
          await saveDeviceToServer(device);
          updateUIForDevice(id);
        }
      });
    }

    const deviceSelect = card.querySelector('.device-select');
    if (deviceSelect) {
      deviceSelect.addEventListener('change', async (e) => {
        e.stopPropagation();
        const id = deviceSelect.getAttribute('data-id');
        const selectedDevice = deviceSelect.value;
        const device = devicesData.find(d => d.id === id);
        if (device && device.type === 'Розетка') {
          device.connectedDevice = selectedDevice;
          if (device.status) {
            device.state = `питает ${device.connectedDevice}`;
          } else {
            device.state = `выключена (${device.connectedDevice} не питается)`;
          }
          await saveDeviceToServer(device);
          updateUIForDevice(id);
        }
      });
    }

    const tempSlider = card.querySelector('.temp-slider');
    if (tempSlider) {
      tempSlider.addEventListener('input', async (e) => {
        e.stopPropagation();
        const id = tempSlider.getAttribute('data-id');
        const newTemp = parseInt(e.target.value);
        const device = devicesData.find(d => d.id === id);
        if (device && device.type === 'Кондиционер') {
          device.targetTemp = newTemp;
          if (device.status) {
            device.temperature = newTemp;
            if (newTemp < 20) device.state = `охлаждение до ${newTemp}°C`;
            else if (newTemp > 24) device.state = `обогрев до ${newTemp}°C`;
            else device.state = `поддержание ${newTemp}°C`;
          } else {
            device.state = `выключен (установлена ${newTemp}°C)`;
          }
          await saveDeviceToServer(device);
          updateUIForDevice(id);
        }
      });
    }
  });
}

function selectDevice(deviceId) {
  currentDeviceId = deviceId;
  updateInfoPanel(deviceId);
  renderDevices(currentRoomFilter);
}

// === ЕДИНСТВЕННАЯ ВЕРСИЯ updateInfoPanel (с озвучиванием) ===
function updateInfoPanel(deviceId) {
  if (!deviceId) {
    document.getElementById('device-info-name').textContent = 'Выберите устройство';
    document.getElementById('device-info-status').textContent = 'Нажмите на сферу в 3D-плане';
    return;
  }
  const device = devicesData.find(d => d.id === deviceId);
  if (!device) return;
  document.getElementById('device-info-name').textContent = `${device.name} (${device.room})`;
  let details = `Состояние: ${device.status ? '🟢 Включено' : '🔴 Выключено'}<br>`;
  details += `Производитель: ${device.manufacturer}<br>`;
  details += `Режим: ${device.state}<br>`;
  if (device.battery !== null) details += `Заряд батареи: ${device.battery}%<br>`;
  if (device.type === 'Робот-пылесос' && device.targetRoom) details += `Целевая комната: ${device.targetRoom}<br>`;
  if (device.type === 'Кондиционер') details += `Температура: ${device.temperature}°C (установлена ${device.targetTemp}°C)<br>`;
  if (device.type === 'Розетка') details += `Подключённый прибор: ${device.connectedDevice}<br>`;
  document.getElementById('device-info-status').innerHTML = details;

  const speakBtn = document.getElementById('speak-info-btn');
  if (speakBtn) {
    const newBtn = speakBtn.cloneNode(true);
    speakBtn.parentNode.replaceChild(newBtn, speakBtn);
    newBtn.addEventListener('click', () => {
      let textToSpeak = `${device.name}, комната ${device.room}. `;
      textToSpeak += device.status ? 'Включено. ' : 'Выключено. ';
      textToSpeak += device.state + '. ';
      if (device.battery !== null) textToSpeak += `Заряд батареи ${device.battery} процентов. `;
      if (device.type === 'Кондиционер') textToSpeak += `Температура ${device.temperature} градусов. `;
      speakText(textToSpeak);
    });
  }
}

// --- Расписания (localStorage) ---
function getSchedulesKey() {
  return `schedules_${currentUserId}`;
}

function loadSchedules() {
  const key = getSchedulesKey();
  const data = localStorage.getItem(key);
  return data ? JSON.parse(data) : [];
}

function saveSchedules(schedules) {
  const key = getSchedulesKey();
  localStorage.setItem(key, JSON.stringify(schedules));
}

function addSchedule(schedule) {
  const schedules = loadSchedules();
  schedule.id = Date.now() + '_' + Math.random().toString(36).substr(2, 4);
  schedules.push(schedule);
  saveSchedules(schedules);
  return schedule;
}

function deleteSchedule(scheduleId) {
  let schedules = loadSchedules();
  schedules = schedules.filter(s => s.id !== scheduleId);
  saveSchedules(schedules);
}

function deleteSchedulesForDevice(deviceId) {
  let schedules = loadSchedules();
  schedules = schedules.filter(s => s.deviceId !== deviceId);
  saveSchedules(schedules);
}

function getDeviceSchedules(deviceId) {
  return loadSchedules().filter(s => s.deviceId === deviceId);
}

function formatScheduleDisplay(schedule) {
  const daysMap = {0:'Вс',1:'Пн',2:'Вт',3:'Ср',4:'Чт',5:'Пт',6:'Сб'};
  const days = schedule.days.map(d => daysMap[d]).join(', ');
  const actionText = schedule.action === 'start' ? 'Включить' : 'Выключить';
  let extra = '';
  if (schedule.room) extra = ` в ${schedule.room}`;
  return `${schedule.time} (${days}) → ${actionText}${extra}`;
}

function openScheduleModal(deviceId) {
  const device = devicesData.find(d => d.id === deviceId);
  if (!device) return;
  const modal = document.getElementById('schedule-modal');
  const deviceNameSpan = document.getElementById('schedule-device-name');
  deviceNameSpan.textContent = device.name;

  const actionContainer = document.getElementById('schedule-action-container');
  const roomContainer = document.getElementById('schedule-room-container');
  const actionSelect = document.getElementById('schedule-action');
  
  if (device.type === 'Робот-пылесос') {
    actionContainer.style.display = 'block';
    roomContainer.style.display = 'block';
    actionSelect.innerHTML = `<option value="start">▶️ Начать уборку</option><option value="stop">⏹️ Вернуться на базу</option>`;
  } else if (device.type === 'Стиральная машина') {
    actionContainer.style.display = 'block';
    roomContainer.style.display = 'none';
    actionSelect.innerHTML = `<option value="start">▶️ Включить стирку</option><option value="stop">⏹️ Выключить</option>`;
  } else {
    actionContainer.style.display = 'block';
    roomContainer.style.display = 'none';
  }

  document.getElementById('schedule-hour').value = '09';
  document.getElementById('schedule-minute').value = '00';
  document.querySelectorAll('.days-checkboxes input').forEach(cb => cb.checked = false);
  document.getElementById('schedule-room').value = '';

  refreshScheduleList(deviceId);
  modal.style.display = 'flex';
  modal.dataset.currentDeviceId = deviceId;
}

function refreshScheduleList(deviceId) {
  const schedules = getDeviceSchedules(deviceId);
  const container = document.getElementById('schedule-list-container');
  if (!container) return;
  if (schedules.length === 0) {
    container.innerHTML = '<li style="text-align:center; color: var(--text-secondary);">Нет расписаний</li>';
    return;
  }
  container.innerHTML = schedules.map(sched => `
    <li>
      <span class="schedule-item-info">${formatScheduleDisplay(sched)}</span>
      <button class="delete-schedule-btn" data-id="${sched.id}">🗑️</button>
    </li>
  `).join('');
  container.querySelectorAll('.delete-schedule-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const schedId = btn.getAttribute('data-id');
      deleteSchedule(schedId);
      refreshScheduleList(deviceId);
      showNotification('Расписание удалено', 'info');
    });
  });
}

function addScheduleFromForm() {
  const modal = document.getElementById('schedule-modal');
  const deviceId = modal.dataset.currentDeviceId;
  if (!deviceId) return;
  const device = devicesData.find(d => d.id === deviceId);
  if (!device) return;

  const hour = parseInt(document.getElementById('schedule-hour').value, 10);
  const minute = parseInt(document.getElementById('schedule-minute').value, 10);
  if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    alert('Некорректное время');
    return;
  }
  const time = `${hour.toString().padStart(2,'0')}:${minute.toString().padStart(2,'0')}`;
  
  const days = [];
  document.querySelectorAll('.days-checkboxes input:checked').forEach(cb => {
    days.push(parseInt(cb.value, 10));
  });
  if (days.length === 0) {
    alert('Выберите хотя бы один день недели');
    return;
  }

  let action = document.getElementById('schedule-action').value;
  let room = null;
  if (device.type === 'Робот-пылесос') {
    room = document.getElementById('schedule-room').value;
    if (action === 'start' && !room) {
      room = device.targetRoom || '';
    }
  }

  const schedule = {
    deviceId: deviceId,
    time: time,
    days: days,
    action: action,
    room: room || null
  };
  addSchedule(schedule);
  refreshScheduleList(deviceId);
  showNotification('Расписание добавлено', 'info');
}

function startScheduleChecker() {
  if (scheduleCheckInterval) clearInterval(scheduleCheckInterval);
  scheduleCheckInterval = setInterval(() => {
    checkSchedules();
  }, 60000);
}

async function checkSchedules() {
  const now = new Date();
  const currentTime = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}`;
  const currentDay = now.getDay();
  const schedules = loadSchedules();
  
  for (const sched of schedules) {
    if (sched.time === currentTime && sched.days.includes(currentDay)) {
      const device = devicesData.find(d => d.id === sched.deviceId);
      if (!device) continue;
      
      if (sched.action === 'start') {
        if (device.type === 'Робот-пылесос') {
          if (!device.status) {
            if (sched.room && sched.room !== device.targetRoom) {
              device.targetRoom = sched.room;
              device.state = `готов к уборке в ${device.targetRoom}`;
              await saveDeviceToServer(device);
            }
            await toggleDeviceStatus(device.id);
            showNotification(`🤖 Робот-пылесос "${device.name}" начал уборку по расписанию`, 'info');
          }
        } else if (device.type === 'Стиральная машина') {
          if (!device.status) {
            await toggleDeviceStatus(device.id);
            showNotification(`🧺 Стиральная машина "${device.name}" включена по расписанию`, 'info');
          }
        }
      } else if (sched.action === 'stop') {
        if (device.type === 'Робот-пылесос') {
          if (device.status) {
            await toggleDeviceStatus(device.id);
            showNotification(`🤖 Робот-пылесос "${device.name}" вернулся на базу по расписанию`, 'info');
          }
        } else if (device.type === 'Стиральная машина') {
          if (device.status) {
            await toggleDeviceStatus(device.id);
            showNotification(`🧺 Стиральная машина "${device.name}" выключена по расписанию`, 'info');
          }
        }
      }
    }
  }
}

// --- 3D сцена ---
function init3D() {
  const container = document.getElementById('canvas-container');
  if (!container) return;
  while (container.firstChild) container.removeChild(container.firstChild);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0f1c);
  scene.fog = new THREE.FogExp2(0x0a0f1c, 0.008);

  camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 1000);
  camera.position.set(6, 4, 7);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);

  labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(container.clientWidth, container.clientHeight);
  labelRenderer.domElement.style.position = 'absolute';
  labelRenderer.domElement.style.top = '0px';
  labelRenderer.domElement.style.left = '0px';
  labelRenderer.domElement.style.pointerEvents = 'none';
  container.appendChild(labelRenderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0.5, 0);

  const ambientLight = new THREE.AmbientLight(0x404060);
  scene.add(ambientLight);
  const mainLight = new THREE.DirectionalLight(0xfff5e6, 1);
  mainLight.position.set(5, 10, 4);
  mainLight.castShadow = true;
  scene.add(mainLight);
  const fillLight = new THREE.PointLight(0x4466cc, 0.3);
  fillLight.position.set(-2, 3, 4);
  scene.add(fillLight);

  const floorMat = new THREE.MeshStandardMaterial({ color: 0x2a2a3a, roughness: 0.7, metalness: 0.1 });
  const floorPlane = new THREE.Mesh(new THREE.PlaneGeometry(14, 12), floorMat);
  floorPlane.rotation.x = -Math.PI / 2;
  floorPlane.position.y = -0.1;
  floorPlane.receiveShadow = true;
  scene.add(floorPlane);

  const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x6c8db0, transparent: true, opacity: 0.2 });
  const wallsPos = [
    { pos: [0, 1.5, -4.2], scale: [12, 3, 0.2] },
    { pos: [0, 1.5, 4.5], scale: [12, 3, 0.2] },
    { pos: [-5.5, 1.5, 0], scale: [0.2, 3, 9] },
    { pos: [5.5, 1.5, 0], scale: [0.2, 3, 9] }
  ];
  wallsPos.forEach(w => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(...w.scale), wallMaterial);
    wall.position.set(w.pos[0], w.pos[1], w.pos[2]);
    wall.receiveShadow = true;
    scene.add(wall);
  });

  const furnitureMat = new THREE.MeshStandardMaterial({ color: 0xa67c52, roughness: 0.6 });
  const sofa = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 0.9), furnitureMat);
  sofa.position.set(-2.2, -0.1, 1.2);
  sofa.castShadow = true;
  scene.add(sofa);
  const table = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.7, 0.5, 6), new THREE.MeshStandardMaterial({ color: 0xbc9a6c }));
  table.position.set(3, -0.1, 2);
  table.castShadow = true;
  scene.add(table);

  const roomLabels = [
    { name: 'Гостиная', pos: [-1, 1.2, 3] },
    { name: 'Кухня', pos: [4, 1.2, 2] },
    { name: 'Спальня', pos: [-3, 1.2, -2] },
    { name: 'Кабинет', pos: [2, 1.2, -2] }
  ];
  roomLabels.forEach(r => {
    const div = document.createElement('div');
    div.textContent = r.name;
    div.style.cssText = 'color: #aaccff; font-size: 14px; font-weight: bold; text-shadow: 1px 1px 0 #000; background: rgba(0,0,0,0.5); padding: 2px 8px; border-radius: 20px;';
    const label = new CSS2DObject(div);
    label.position.set(r.pos[0], r.pos[1], r.pos[2]);
    scene.add(label);
  });

  devicesData.forEach(device => addDeviceTo3D(device));

  raycaster = new THREE.Raycaster();
  mouse = new THREE.Vector2();
  window.addEventListener('click', (event) => {
    if (!document.getElementById('map-tab').classList.contains('active')) return;
    if (!renderer || !renderer.domElement) return;
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(Array.from(deviceMeshes.values()).map(item => item.mesh));
    if (intersects.length > 0) {
      const hitMesh = intersects[0].object;
      const deviceId = hitMesh.userData.deviceId;
      if (deviceId) {
        selectDevice(deviceId);
        toggleDeviceStatus(deviceId);
      }
    }
  });

  renderer.domElement.addEventListener('mousedown', (event) => {
    if (!document.getElementById('map-tab').classList.contains('active')) return;
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(Array.from(deviceMeshes.values()).map(item => item.mesh));
    if (intersects.length > 0) {
      dragObject = intersects[0].object;
      dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), dragObject.position.y);
      const intersectionPoint = new THREE.Vector3();
      raycaster.ray.intersectPlane(dragPlane, intersectionPoint);
      dragOffset.copy(dragObject.position).sub(intersectionPoint);
      event.preventDefault();
      renderer.domElement.style.cursor = 'grabbing';
    }
  });

  window.addEventListener('mousemove', (event) => {
    if (!dragObject || !dragPlane) return;
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const intersectionPoint = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(dragPlane, intersectionPoint)) {
      const newPos = intersectionPoint.clone().add(dragOffset);
      newPos.x = Math.min(5.5, Math.max(-5.5, newPos.x));
      newPos.z = Math.min(4.5, Math.max(-4.2, newPos.z));
      dragObject.position.copy(newPos);
      const deviceId = dragObject.userData.deviceId;
      const entry = deviceMeshes.get(deviceId);
      if (entry && entry.label) {
        entry.label.position.copy(newPos).add(new THREE.Vector3(0, 0.65, 0));
      }
    }
  });

  window.addEventListener('mouseup', async (event) => {
    if (dragObject) {
      const deviceId = dragObject.userData.deviceId;
      const device = devicesData.find(d => d.id === deviceId);
      if (device) {
        const newPos = dragObject.position;
        device.pos = { x: newPos.x, y: newPos.y, z: newPos.z };
        await saveDeviceToServer(device);
        showNotification(`Позиция "${device.name}" сохранена`, 'info');
      }
      dragObject = null;
      dragPlane = null;
      renderer.domElement.style.cursor = 'default';
    }
  });

  function animate() {
    requestAnimationFrame(animate);
    if (!renderer || !scene || !camera) return;
    if (controls) controls.update();
    renderer.render(scene, camera);
    if (labelRenderer) labelRenderer.render(scene, camera);
  }
  animate();

  window.addEventListener('resize', onWindowResize);
}

function addDeviceTo3D(device) {
  if (!scene) return;
  const color = device.status ? 0x4caf50 : 0xf44336;
  const sphereGeo = new THREE.SphereGeometry(0.38, 32, 32);
  const material = new THREE.MeshStandardMaterial({
    color: color,
    emissive: device.status ? 0x226622 : 0x330000,
    emissiveIntensity: device.status ? 0.4 : 0.1,
    metalness: 0.3
  });
  const sphere = new THREE.Mesh(sphereGeo, material);
  sphere.userData = { deviceId: device.id, type: 'device' };
  sphere.position.set(device.pos.x, device.pos.y, device.pos.z);
  sphere.castShadow = true;
  scene.add(sphere);

  const div = document.createElement('div');
  div.textContent = device.name;
  div.style.cssText = 'color:#eef4ff;font-size:12px;font-weight:bold;text-shadow:1px 1px 0 #000;background:rgba(0,0,0,0.6);padding:2px 8px;border-radius:20px;border-left:3px solid ' + (device.status ? '#4caf50' : '#f44336') + ';font-family:sans-serif;white-space:nowrap;';
  const label = new CSS2DObject(div);
  label.position.set(device.pos.x, device.pos.y + 0.65, device.pos.z);
  scene.add(label);

  deviceMeshes.set(device.id, { mesh: sphere, label, device });
}

function updateDevice3DVisual(deviceId) {
  const entry = deviceMeshes.get(deviceId);
  if (!entry) return;
  const device = entry.device;
  const mesh = entry.mesh;
  const labelObj = entry.label;
  const newColor = device.status ? 0x4caf50 : 0xf44336;
  mesh.material.color.setHex(newColor);
  mesh.material.emissiveIntensity = device.status ? 0.4 : 0.05;
  if (labelObj && labelObj.element) {
    labelObj.element.style.borderLeftColor = device.status ? '#4caf50' : '#f44336';
  }
}

function rebuild3DScene() {
  if (renderer) {
    renderer.dispose();
    if (labelRenderer) labelRenderer.domElement?.remove();
    const container = document.getElementById('canvas-container');
    if (container) {
      while (container.firstChild) container.removeChild(container.firstChild);
    }
    deviceMeshes.clear();
    init3D();
  }
}

function onWindowResize() {
  const container = document.getElementById('canvas-container');
  if (!container || !renderer || !camera) return;
  const width = container.clientWidth;
  const height = container.clientHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  if (labelRenderer) labelRenderer.setSize(width, height);
}

function initUIAfterAuth() {
  initTabs();
  initFilters();
  initAddDeviceModal();
  initProfileModal();
  initTheme();
  initSupportButton();
  setupPhotoUpload();
  initScheduleModal();
  initAccessibility();        // <-- ДОБАВЬТЕ ЭТУ СТРОКУ
  renderDevices(currentRoomFilter);
  if (devicesData.length > 0) selectDevice(devicesData[0].id);
  else updateInfoPanel(null);


  // ===== Режим для слабовидящих =====
  loadAccessibilityMode();
  const accessBtn = document.getElementById('accessibility-toggle');
  if (accessBtn) {
    accessBtn.removeEventListener('click', toggleAccessibilityMode);
    accessBtn.addEventListener('click', toggleAccessibilityMode);
  }
}

function initScheduleModal() {
  const modal = document.getElementById('schedule-modal');
  const closeBtn = modal.querySelector('.close-modal');
  const addBtn = document.getElementById('add-schedule-btn');
  
  closeBtn.addEventListener('click', () => {
    modal.style.display = 'none';
    delete modal.dataset.currentDeviceId;
  });
  window.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.style.display = 'none';
      delete modal.dataset.currentDeviceId;
    }
  });
  addBtn.addEventListener('click', addScheduleFromForm);
}

function initTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const contents = { home: document.getElementById('home-tab'), devices: document.getElementById('devices-tab'), map: document.getElementById('map-tab') };
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.getAttribute('data-tab');
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      Object.keys(contents).forEach(key => contents[key].classList.remove('active'));
      if (tabName === 'home') contents.home.classList.add('active');
      else if (tabName === 'devices') contents.devices.classList.add('active');
      else if (tabName === 'map') {
        contents.map.classList.add('active');
        if (!renderer) init3D();
        else setTimeout(() => onWindowResize(), 50);
      }
    });
  });
  document.getElementById('try-now-btn').addEventListener('click', () => {
    document.querySelector('.tab-btn[data-tab="devices"]').click();
  });
}

function initFilters() {
  const filterBtns = document.querySelectorAll('.filter-btn');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentRoomFilter = btn.getAttribute('data-room');
      renderDevices(currentRoomFilter);
    });
  });
}

function initAddDeviceModal() {
  const modal = document.getElementById('add-device-modal');
  const addBtn = document.getElementById('add-device-btn');
  const closeBtn = modal.querySelector('.close-modal');
  const confirmBtn = document.getElementById('confirm-add-device');

  addBtn.addEventListener('click', () => modal.style.display = 'flex');
  closeBtn.addEventListener('click', () => modal.style.display = 'none');
  window.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

  confirmBtn.addEventListener('click', async () => {
    const name = document.getElementById('device-name').value.trim();
    if (!name) {
      alert('Введите название устройства');
      return;
    }
    const type = document.getElementById('device-type').value;
    const room = document.getElementById('device-room').value;
    const manufacturer = document.getElementById('device-manufacturer').value.trim() || 'Generic';
    const status = document.getElementById('device-status').checked;

    await addDeviceToServer({ name, type, room, manufacturer, status });
    modal.style.display = 'none';
    document.getElementById('device-name').value = '';
    document.getElementById('device-status').checked = false;
  });
}

function initProfileModal() {
  const modal = document.getElementById('profile-modal');
  const panel = document.getElementById('profile-panel');
  if (!modal || !panel) return;

  const closeBtn = modal.querySelector('.close-modal');
  const saveBtn = document.getElementById('save-profile-btn');
  const nicknameInput = document.getElementById('nickname-input');
  const avatarPreview = document.getElementById('avatar-preview');
  
  if (!avatarPreview) {
    console.warn('Элемент #avatar-preview не найден');
    return;
  }
  
  const avatarChoices = document.querySelectorAll('.avatar-choice');
  
  panel.addEventListener('click', async () => {
    const profile = await loadUserProfile();
    if (avatarPreview) avatarPreview.textContent = profile.avatar || '👤';
    if (nicknameInput) nicknameInput.value = profile.nickname || profile.username;
    modal.style.display = 'flex';
  });
  
  if (closeBtn) {
    closeBtn.addEventListener('click', () => modal.style.display = 'none');
  }
  window.addEventListener('click', (e) => {
    if (e.target === modal) modal.style.display = 'none';
  });
  
  avatarChoices.forEach(btn => {
    btn.addEventListener('click', () => {
      const avatar = btn.getAttribute('data-avatar');
      if (avatar) {
        avatarPreview.textContent = avatar;
      } else if (btn.id === 'upload-avatar-btn') {
        showNotification('Загрузка изображения не поддерживается в демо, используйте эмодзи', 'info');
      }
    });
  });
  
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const newNickname = nicknameInput?.value.trim() || (await loadUserProfile()).username;
      const newAvatar = avatarPreview.textContent || '👤';
      await saveProfileSettings(newAvatar, newNickname);
      modal.style.display = 'none';
    });
  }
  
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      currentUserId = null;
      localStorage.removeItem('currentUserId');
      
      if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
      }
      if (scheduleCheckInterval) {
        clearInterval(scheduleCheckInterval);
        scheduleCheckInterval = null;
      }
      
      devicesData = [];
      if (deviceMeshes.size) {
        deviceMeshes.forEach((entry) => {
          if (scene) {
            scene.remove(entry.mesh);
            scene.remove(entry.label);
          }
        });
        deviceMeshes.clear();
      }
      
      if (renderer) {
        renderer.dispose();
        renderer = null;
      }
      if (labelRenderer) {
        labelRenderer.domElement?.remove();
        labelRenderer = null;
      }
      
      modal.style.display = 'none';
      showAuthModal();
      
      const devicesContainer = document.getElementById('devices-container');
      if (devicesContainer) devicesContainer.innerHTML = '';
      updateInfoPanel(null);
    });
  }
}

function setupPhotoUpload() {
  const btn = document.getElementById('upload-photo-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const statusDiv = document.getElementById('ai-status');
        if (statusDiv) statusDiv.style.display = 'flex';
        setTimeout(() => {
          const newLayout = generateRandomRoomLayout();
          devicesData = newLayout.devices;
          Promise.all(devicesData.map(dev => saveDeviceToServer(dev))).then(() => {
            rebuild3DScene();
            renderDevices(currentRoomFilter);
            if (statusDiv) statusDiv.style.display = 'none';
            showNotification('✅ ИИ успешно обработал фото! Схема обновлена.', 'info');
          });
        }, 2000);
      };
      reader.readAsDataURL(file);
    };
    input.click();
  });
}

function generateRandomRoomLayout() {
  const rooms = [
    { name: 'Гостиная', pos: { x: -2, z: 2 }, size: { w: 3, h: 3 } },
    { name: 'Кухня', pos: { x: 3, z: 1 }, size: { w: 2.5, h: 2 } },
    { name: 'Спальня', pos: { x: -2.5, z: -2 }, size: { w: 3, h: 2.5 } },
    { name: 'Кабинет', pos: { x: 2, z: -2 }, size: { w: 2.5, h: 2 } }
  ];
  const shuffled = [...rooms];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const newDevices = devicesData.map(device => {
    const room = shuffled.find(r => r.name === device.room) || rooms[0];
    const x = room.pos.x + (Math.random() - 0.5) * (room.size.w - 1);
    const z = room.pos.z + (Math.random() - 0.5) * (room.size.h - 1);
    const y = device.type === 'Робот-пылесос' ? 0.2 : 0.8;
    return { ...device, pos: { x, y, z } };
  });
  return { devices: newDevices, rooms: shuffled };
}

// --- Тема ---
function initTheme() {
  const savedTheme = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = savedTheme || (prefersDark ? 'dark' : 'light');
  document.body.classList.toggle('dark', theme === 'dark');
  updateThemeButton();

  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.removeEventListener('click', toggleTheme);
    btn.addEventListener('click', toggleTheme);
  }
}

function updateThemeButton() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  const isDark = document.body.classList.contains('dark');
  btn.textContent = isDark ? '☀️' : '🌙';
  btn.title = isDark ? 'Светлая тема' : 'Тёмная тема';
}

function toggleTheme() {
  document.body.classList.toggle('dark');
  const isDark = document.body.classList.contains('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  updateThemeButton();
}

function initSupportButton() {
  const btn = document.getElementById('support-btn');
  if (btn) {
    btn.removeEventListener('click', supportClickHandler);
    btn.addEventListener('click', supportClickHandler);
  }
}

function supportClickHandler() {
  alert('🆘 Круглосуточная поддержка:\n📞 +7-800-450-01-50\n✉️ support@rosthome.ru\n💬 Telegram: @rosthome_support');
}

// --- Запуск ---
window.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initSupportButton();

  const savedUserId = localStorage.getItem('currentUserId');
  if (savedUserId) {
    currentUserId = savedUserId;
    loadUserProfile().then(() => {
      loadDevices().then(() => {
        initUIAfterAuth();
        startAIMonitoring();
        startScheduleChecker();
      });
    });
  } else {
    showAuthModal();
  }
});
window.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initSupportButton();
  initAccessibility();   // <-- ДОБАВЬТЕ ЭТУ СТРОКУ

  const savedUserId = localStorage.getItem('currentUserId');
  // ... остальной код
});
