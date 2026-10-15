/**
 * HelioTrack Bridge - USB Serial to Supabase IoT Gateway
 * Membaca payload dari tabel inverter_logs.
 * Tidak mengirim data baru ke Supabase.
 */

const AdminApp = {
  state: {
    parserMode: 'auto',
    csvDelimiter: 'auto',
    csvPreset: 'v,i,p,e,irr,deg',
    baudRate: 115200,

    serialPort: null,
    serialReader: null,
    serialStreamClosed: null,
    isConnected: false,

    rxCount: 0,
    syncedCount: 0,
    lastPacketTime: null,

    chartMetric: 'power',
    chartHistory: [],

    supabaseStatus: 'checking',
    recentLogs: [],

    autoScroll: true,
    terminalLines: []
  },

  init() {
    this.initDateTimeInputs();
    this.initChartHistory();
    this.bindEvents();
    this.checkSupabaseConnection();
    this.loadRecentLogs();
    this.setupRealtimeListener();
    this.renderRealtimeChart();

    if ('serial' in navigator) {
      navigator.serial.addEventListener('disconnect', () => {
        this.logTerminal(
          'sys',
          'SYSTEM',
          'Port USB terputus dari sistem.'
        );
        this.handleDisconnectCleanup();
      });
    }
  },

  initDateTimeInputs() {
    const now = new Date();
    const dateInput = document.getElementById('input-tanggal');
    const timeInput = document.getElementById('input-jam');

    if (dateInput) {
      dateInput.value = now.toISOString().split('T')[0];
    }

    if (timeInput) {
      timeInput.value = now.toTimeString().split(' ')[0];
    }
  },

  initChartHistory() {
    const initial = [];
    const now = Date.now();

    for (let i = 12; i >= 0; i--) {
      const time = new Date(now - i * 5000);

      const voltage = +(385 + Math.sin(i) * 3).toFixed(1);
      const current = +(12.5 + Math.cos(i) * 0.4).toFixed(2);

      initial.push({
        time: time.toTimeString().split(' ')[0],
        voltage,
        current,
        power: +(voltage * current).toFixed(1),
        irradiance: 0,
        angle: 0
      });
    }

    this.state.chartHistory = initial;
  },

  setParserMode(mode) {
    this.state.parserMode = mode;

    ['auto', 'json', 'csv'].forEach((item) => {
      const button = document.getElementById(`btn-mode-${item}`);

      if (button) {
        button.classList.toggle('active', item === mode);
      }
    });

    const status = document.getElementById('stat-parser-mode');

    if (status) {
      status.textContent = {
        auto: 'AUTO (JSON/CSV)',
        json: 'JSON STRICT',
        csv: 'CSV STRICT'
      }[mode] || mode.toUpperCase();
    }

    this.logTerminal(
      'sys',
      'CONFIG',
      `Mode parser diubah ke: ${mode.toUpperCase()}`
    );
  },

  async toggleSerialConnection() {
    if (this.state.isConnected) {
      await this.disconnectSerial();
    } else {
      await this.connectSerial();
    }
  },

  async connectSerial() {
    if (!('serial' in navigator)) {
      alert(
        'Web Serial API tidak didukung browser ini. ' +
        'Gunakan Chrome atau Edge desktop.'
      );
      return;
    }

    const baudInput = document.getElementById('select-baudrate');
    const baudRate = baudInput
      ? parseInt(baudInput.value, 10)
      : 115200;

    this.state.baudRate = baudRate;

    try {
      this.logTerminal(
        'sys',
        'SYSTEM',
        `Memilih port USB pada ${baudRate} bps...`
      );

      const port = await navigator.serial.requestPort();
      await port.open({ baudRate });

      this.state.serialPort = port;
      this.state.isConnected = true;

      const statusText = document.getElementById('usb-status-text');
      const buttonText = document.getElementById('btn-serial-text');

      if (statusText) {
        statusText.textContent = `USB Terhubung (${baudRate})`;
      }

      if (buttonText) {
        buttonText.textContent = 'Putuskan USB';
      }

      this.logTerminal(
        'sys',
        'CONNECTED',
        `Port USB dibuka pada ${baudRate} bps.`
      );

      this.startSerialReadLoop(port);
    } catch (error) {
      if (error.name !== 'NotFoundError') {
        this.logTerminal('err', 'SERIAL ERR', error.message);
        this.showToast(`Gagal: ${error.message}`, '⚠️');
      }
    }
  },

  async startSerialReadLoop(port) {
    try {
      const decoder = new TextDecoderStream();

      this.state.serialStreamClosed =
        port.readable.pipeTo(decoder.writable);

      const reader = decoder.readable.getReader();
      this.state.serialReader = reader;

      let buffer = '';

      while (this.state.isConnected) {
        const { value, done } = await reader.read();

        if (done) break;

        if (value) {
          buffer += value;

          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();

            if (trimmed) {
              this.parseRawData(trimmed);
            }
          }
        }
      }
    } catch (error) {
      if (this.state.isConnected) {
        this.logTerminal('err', 'STREAM ERR', error.message);
      }
    } finally {
      this.handleDisconnectCleanup();
    }
  },

  async disconnectSerial() {
    this.state.isConnected = false;

    try {
      if (this.state.serialReader) {
        await this.state.serialReader.cancel();
        this.state.serialReader.releaseLock();
      }
    } catch (error) {
      console.warn('Gagal menutup reader:', error);
    }

    try {
      if (this.state.serialPort) {
        await this.state.serialPort.close();
      }
    } catch (error) {
      console.warn('Gagal menutup port:', error);
    }

    this.handleDisconnectCleanup();
  },

  handleDisconnectCleanup() {
    this.state.isConnected = false;
    this.state.serialReader = null;
    this.state.serialPort = null;

    const statusText = document.getElementById('usb-status-text');
    const buttonText = document.getElementById('btn-serial-text');

    if (statusText) {
      statusText.textContent = 'USB Terputus';
    }

    if (buttonText) {
      buttonText.textContent = 'Hubungkan USB';
    }
  },

  parseRawData(raw) {
    this.state.rxCount++;

    const count = document.getElementById('stat-rx-count');

    if (count) {
      count.textContent = this.state.rxCount;
    }

    this.state.lastPacketTime = new Date();

    const lastTime = document.getElementById('stat-last-time');

    if (lastTime) {
      lastTime.textContent =
        this.state.lastPacketTime.toLocaleTimeString('id-ID');
    }

    this.logTerminal('rx', 'RX', raw);

    let parsed = null;

    if (
      this.state.parserMode === 'auto' ||
      this.state.parserMode === 'json'
    ) {
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        if (this.state.parserMode === 'json') {
          this.logTerminal('err', 'PARSE ERR', 'Format JSON tidak valid.');
          return;
        }
      }
    }

    if (!parsed && (
      this.state.parserMode === 'auto' ||
      this.state.parserMode === 'csv'
    )) {
      parsed = this.parseCSV(raw);
    }

    if (!parsed) {
      this.logTerminal('err', 'PARSE ERR', 'Data tidak dapat dibaca.');
      return;
    }

    this.applyTelemetryToMonitor(parsed);
  },

  parseCSV(raw) {
    const values = raw.split(
      this.state.csvDelimiter === 'auto'
        ? /[,;\s]+/
        : this.state.csvDelimiter
    );

    if (values.length < 3) return null;

    const numbers = values.map((value) => Number(value));

    if (numbers.some((value) => !Number.isFinite(value))) {
      return null;
    }

    return {
      pv_voltage: numbers[0],
      output_voltage: numbers[1],
      controller_charging_curr: numbers[2],
      raw_text: raw
    };
  },

  applyTelemetryToMonitor(record) {
  const fields = {
    pv_voltage: 'val-pv-voltage',
    output_voltage: 'val-output-voltage',
    battery_voltage: 'val-battery-voltage',
    battery_capacity: 'val-battery-capacity',
    controller_temp: 'val-controller-temp',
    inverter_temp: 'val-inverter-temp',
    operating_status: 'val-operating-status',
    load_percentage: 'val-load-percentage',
    controller_charging_curr: 'val-charging-curr', // Disesuaikan dengan ID di HTML
    raw_text: 'val-raw-text'                       // Ditambahkan agar raw_text ter-update
  };

  Object.entries(fields).forEach(([key, elementId]) => {
    const element = document.getElementById(elementId);
    
    // Mengecek pencocokan key utama maupun fallback penulisan typo (misal: battery_capaticity)
    let val = record[key];
    if (key === 'battery_capacity' && val === undefined) {
      val = record.battery_capaticity;
    }

    if (element && val !== undefined && val !== null) {
      element.textContent = val;
    }
  });

  const voltage = Number(record.pv_voltage);
  const current = Number(record.controller_charging_curr);

  if (Number.isFinite(voltage) && Number.isFinite(current)) {
    this.pushToRealtimeChart({
      voltage,
      current,
      power: voltage * current,
      irradiance: 0,
      angle: 0,
      time: new Date().toLocaleTimeString('id-ID')
    });
  }
},

  async checkSupabaseConnection() {
    const statusText = document.getElementById('supa-status-text');

    try {
      const result = await window.SolarDB.testConnection();

      this.state.supabaseStatus = result.success
        ? 'connected'
        : 'error';

      if (statusText) {
        statusText.textContent = result.success
          ? 'Supabase Terhubung'
          : 'Supabase: ' + result.message;
      }
    } catch (error) {
      this.state.supabaseStatus = 'error';

      if (statusText) {
        statusText.textContent = 'Supabase tidak terhubung';
      }
    }
  },

async loadRecentLogs() {
    const tbody = document.getElementById('telemetry-tbody');

    if (!tbody) return;

    tbody.innerHTML = `
      <tr>
        <td colspan="12">Memuat data...</td>
      </tr>
    `;

    try {
      const data = await window.SolarDB.fetchRecent(25);

      this.state.recentLogs = Array.isArray(data) ? data : [];
      this.renderLogsTable(this.state.recentLogs);

      // --- PERBAIKAN: Masukkan baris data terbaru ke kartu monitor atas ---
      if (this.state.recentLogs.length > 0) {
        this.applyTelemetryToMonitor(this.state.recentLogs[0]);
      }
    } catch (error) {
      tbody.innerHTML = `
        <tr>
          <td colspan="12">Gagal memuat data.</td>
        </tr>
      `;

      console.error('Gagal membaca data Supabase:', error);
    }
  },

  renderLogsTable(records) {
    const tbody = document.getElementById('telemetry-tbody');
    const badge = document.getElementById('log-count-badge');

    if (!tbody) return;

    if (badge) {
      badge.textContent = `${records.length} Data`;
    }

    if (!records.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="12">Belum ada data.</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = records.map((record) => {
      const createdAt = record.created_at
        ? new Date(record.created_at).toLocaleString('id-ID')
        : '-';

      const values = [
        record.id,
        createdAt,
        record.pv_voltage,
        record.output_voltage,
        record.battery_voltage,
        record.battery_capacity ?? record.battery_capaticity,
        record.controller_temp,
        record.inverter_temp,
        record.operating_status,
        record.load_percentage,
        record.controller_charging_curr,
        record.raw_text
      ];

      return `
        <tr>
          ${values.map((value) => `
            <td>${this.escapeHTML(value ?? '-')}</td>
          `).join('')}
        </tr>
      `;
    }).join('');
  },

  setupRealtimeListener() {
    if (
      !window.SolarDB ||
      typeof window.SolarDB.subscribeToChanges !== 'function'
    ) {
      return;
    }

    window.SolarDB.subscribeToChanges((record) => {
      if (!record) return;

      this.state.recentLogs.unshift(record);
      this.state.recentLogs =
        this.state.recentLogs.slice(0, 25);

      this.renderLogsTable(this.state.recentLogs);
      this.applyTelemetryToMonitor(record);
    });
  },

  pushToRealtimeChart(record) {
    this.state.chartHistory.push(record);

    if (this.state.chartHistory.length > 25) {
      this.state.chartHistory.shift();
    }

    this.renderRealtimeChart();
  },

  renderRealtimeChart() {
    const history = this.state.chartHistory;

    if (!history.length) return;

    const latest = history[history.length - 1];
    const powers = history.map((item) => Number(item.power) || 0);

    const latestElement = document.getElementById('chart-stat-latest');
    const maxElement = document.getElementById('chart-stat-max');
    const avgElement = document.getElementById('chart-stat-avg');

    if (latestElement) {
      latestElement.textContent =
        `Nilai Terkini: ${latest.power.toFixed(1)} W`;
    }

    if (maxElement) {
      maxElement.textContent =
        `Puncak: ${Math.max(...powers).toFixed(1)} W`;
    }

    if (avgElement) {
      const average = powers.reduce((sum, value) => sum + value, 0)
        / powers.length;

      avgElement.textContent =
        `Rata-rata: ${average.toFixed(1)} W`;
    }
  },

  exportCSV() {
    const records = this.state.recentLogs;

    if (!records.length) {
      this.showToast('Tidak ada data untuk diekspor.', '⚠️');
      return;
    }

    const columns = [
      'id',
      'created_at',
      'pv_voltage',
      'output_voltage',
      'battery_voltage',
      'battery_capacity',
      'controller_temp',
      'inverter_temp',
      'operating_status',
      'load_percentage',
      'raw_text',
      'controller_charging_curr'
    ];

    const escapeCSV = (value) => {
      const text = String(value ?? '');
      return `"${text.replace(/"/g, '""')}"`;
    };

    const csv = [
      columns.join(','),
      ...records.map((record) =>
        columns.map((column) => escapeCSV(
          column === 'battery_capacity'
            ? record.battery_capacity ?? record.battery_capaticity
            : record[column]
        )).join(',')
      )
    ].join('\r\n');

    const blob = new Blob(['\uFEFF' + csv], {
      type: 'text/csv;charset=utf-8;'
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = 'inverter_logs.csv';
    link.click();

    URL.revokeObjectURL(url);
  },

  bindEvents() {
    const autoScroll = document.getElementById('chk-autoscroll');

    if (autoScroll) {
      autoScroll.addEventListener('change', (event) => {
        this.state.autoScroll = event.target.checked;
      });
    }

    const connectButton = document.getElementById('btn-serial-connect');

    if (connectButton) {
      connectButton.addEventListener('click', () => {
        this.toggleSerialConnection();
      });
    }
  },

  logTerminal(type, label, message) {
    const terminal = document.getElementById('terminal-body');

    const entry = {
      time: new Date().toLocaleTimeString('id-ID'),
      type,
      label,
      message
    };

    this.state.terminalLines.push(entry);

    if (this.state.terminalLines.length > 200) {
      this.state.terminalLines.shift();
    }

    if (!terminal) return;

    const row = document.createElement('div');
    row.className = 'log-entry';

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = entry.time;

    const badge = document.createElement('span');
    badge.className = `log-badge ${type}`;
    badge.textContent = label;

    const text = document.createElement('span');
    text.className = 'log-text';
    text.textContent = message;

    row.append(time, badge, text);
    terminal.appendChild(row);

    if (this.state.autoScroll) {
      terminal.scrollTop = terminal.scrollHeight;
    }
  },

  clearTerminal() {
    const terminal = document.getElementById('terminal-body');

    if (terminal) {
      terminal.innerHTML = '';
    }

    this.state.terminalLines = [];
  },

  async copyTerminalLogs() {
    const text = this.state.terminalLines
      .map((line) =>
        `[${line.time}] [${line.label}] ${line.message}`
      )
      .join('\n');

    try {
      await navigator.clipboard.writeText(text);
      this.showToast('Log disalin.', '✓');
    } catch (error) {
      this.showToast('Gagal menyalin log.', '⚠️');
    }
  },

  toggleSection(id) {
    const section = document.getElementById(id);

    if (section) {
      section.classList.toggle('collapsed');
    }
  },

  openModal(id) {
    document.getElementById(id)?.classList.add('active');
  },

  closeModal(id) {
    document.getElementById(id)?.classList.remove('active');
  },

  showToast(message, icon = 'ℹ️') {
    const container = document.getElementById('toast-container');

    if (!container) {
      console.log(message);
      return;
    }

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = `${icon} ${message}`;

    container.appendChild(toast);

    setTimeout(() => toast.remove(), 3000);
  },

  escapeHTML(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
};

window.AdminApp = AdminApp;

document.addEventListener('DOMContentLoaded', () => {
  AdminApp.init();
  
  window.SolarDB.subscribeToChanges((record) => {
    AdminApp.applyTelemetryToMonitor(record);
  });
  
});
