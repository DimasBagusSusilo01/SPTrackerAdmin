/**
 * ==============================================================================
 * HelioTrack Bridge - USB Serial to Supabase IoT Gateway Controller
 * ==============================================================================
 */

const AdminApp = {
  state: {
    // Parser options: 'auto' | 'json' | 'csv'
    parserMode: 'auto',
    csvDelimiter: 'auto',
    csvPreset: 'v,i,p,e,irr,deg',
    autoPushSupabase: true,
    baudRate: 115200,

    // Web Serial state
    serialPort: null,
    serialReader: null,
    serialStreamClosed: null,
    isConnected: false,

    // Statistics
    rxCount: 0,
    syncedCount: 0,
    lastPacketTime: null,
    cumulativeEnergy: 34.8, // kWh

    // Realtime Chart state
    chartMetric: 'power', // 'power' | 'vi' | 'irr'
    chartHistory: [],     // Array of last 25 telemetry readings

    // Supabase & Table state
    supabaseStatus: 'checking',
    recentLogs: [],

    // Terminal
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

    // Listen for USB unplug events
    if ('serial' in navigator) {
      navigator.serial.addEventListener('disconnect', (event) => {
        this.logTerminal('sys', 'SYSTEM', 'Port USB terputus dari sistem (kabel dicabut).');
        this.handleDisconnectCleanup();
      });
    }
  },

  // Inisialisasi default tanggal & waktu
  initDateTimeInputs() {
    const now = new Date();
    const d = document.getElementById('input-tanggal');
    const t = document.getElementById('input-jam');
    if (d) d.value = now.toISOString().split('T')[0];
    if (t) t.value = now.toTimeString().split(' ')[0];
  },

  // Buat histori awal untuk grafik agar langsung hidup saat pertama kali dibuka
  initChartHistory() {
    const baseV = 385.0;
    const baseI = 12.5;
    const baseP = Math.round(baseV * baseI * 10) / 10;
    const baseIrr = 890;
    const baseDeg = 34.5;

    const initial = [];
    const now = Date.now();
    for (let i = 12; i >= 0; i--) {
      const t = new Date(now - i * 5000);
      const v = +(baseV + (Math.sin(i) * 3)).toFixed(1);
      const cur = +(baseI + (Math.cos(i) * 0.4)).toFixed(2);
      const p = +(v * cur).toFixed(1);
      const irr = Math.round(baseIrr + Math.sin(i * 0.8) * 20);
      const deg = +(baseDeg + (12 - i) * 0.05).toFixed(1);
      initial.push({
        time: t.toTimeString().split(' ')[0],
        voltage: v,
        current: cur,
        power: p,
        irradiance: irr,
        angle: deg
      });
    }
    this.state.chartHistory = initial;
  },

  // ==============================================================================
  // PARSER MODE CONTROLS (AUTO / JSON / CSV)
  // ==============================================================================
  setParserMode(mode) {
    this.state.parserMode = mode;

    // Update button active state
    ['auto', 'json', 'csv'].forEach((m) => {
      const btn = document.getElementById(`btn-mode-${m}`);
      if (btn) {
        if (m === mode) btn.classList.add('active');
        else btn.classList.remove('active');
      }
    });

    const statMode = document.getElementById('stat-parser-mode');
    if (statMode) {
      if (mode === 'auto') statMode.textContent = 'AUTO (JSON/CSV)';
      else if (mode === 'json') statMode.textContent = 'JSON STRICT';
      else if (mode === 'csv') statMode.textContent = 'CSV STRICT';
    }

    this.logTerminal('sys', 'CONFIG', `Mode parser diubah ke: ${mode.toUpperCase()}`);
    this.showToast(`Mode parser: ${mode.toUpperCase()}`, '⚙️');
  },

  // ==============================================================================
  // WEB SERIAL API (KONEKSI KABEL USB MIKROKONTROLER)
  // ==============================================================================
  async toggleSerialConnection() {
    if (this.state.isConnected) {
      await this.disconnectSerial();
    } else {
      await this.connectSerial();
    }
  },

  async connectSerial() {
    if (!('serial' in navigator)) {
      alert('Fitur Web Serial API belum didukung di browser ini.\nSilakan gunakan Google Chrome, Microsoft Edge, atau Opera versi desktop.');
      this.logTerminal('err', 'ERROR', 'Web Serial API tidak didukung browser ini. Gunakan Chrome/Edge.');
      return;
    }

    const selectBaud = document.getElementById('select-baudrate');
    const baudRate = selectBaud ? parseInt(selectBaud.value) : 115200;
    this.state.baudRate = baudRate;

    try {
      this.logTerminal('sys', 'SYSTEM', `Membuka dialog pemilihan port USB (Baudrate: ${baudRate})...`);
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: baudRate });

      this.state.serialPort = port;
      this.state.isConnected = true;

      // Update UI Status Pill
      const statusPill = document.getElementById('usb-status-pill');
      const statusText = document.getElementById('usb-status-text');
      const btnConnect = document.getElementById('btn-serial-connect');
      const btnText = document.getElementById('btn-serial-text');

      if (statusText) statusText.textContent = `USB Terhubung (${baudRate})`;
      if (statusPill) statusPill.style.borderColor = 'var(--green-accent)';
      if (btnConnect) btnConnect.classList.replace('btn-primary', 'btn-secondary');
      if (btnText) btnText.textContent = '⛔ Putuskan USB';

      this.logTerminal('sys', 'CONNECTED', `Port Serial berhasil dibuka @ ${baudRate} bps. Menunggu data...`);
      this.showToast(`USB Terhubung (${baudRate} baud)!`, '🔌');

      // Start Read Loop with robust Line Buffer
      this.startSerialReadLoop(port);

    } catch (err) {
      if (err.name !== 'NotFoundError') {
        this.logTerminal('err', 'SERIAL ERR', `Gagal koneksi USB: ${err.message}`);
        this.showToast(`Gagal: ${err.message}`, '⚠️');
      } else {
        this.logTerminal('sys', 'SYSTEM', 'Pemilihan port dibatalkan oleh pengguna.');
      }
    }
  },

  async startSerialReadLoop(port) {
    try {
      const textDecoder = new TextDecoderStream();
      this.state.serialStreamClosed = port.readable.pipeTo(textDecoder.writable);
      const reader = textDecoder.readable.getReader();
      this.state.serialReader = reader;

      let lineBuffer = '';

      while (this.state.isConnected) {
        const { value, done } = await reader.read();
        if (done) break;

        if (value) {
          lineBuffer += value;
          // Split berdasarkan newline (\n atau \r\n)
          const lines = lineBuffer.split(/\r?\n/);
          // Simpan potongan baris terakhir yang belum selesai ke buffer
          lineBuffer = lines.pop();

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length > 0) {
              this.parseRawData(trimmed);
            }
          }
        }
      }
    } catch (err) {
      if (this.state.isConnected) {
        this.logTerminal('err', 'STREAM ERR', `Aliran data serial terputus: ${err.message}`);
      }
    } finally {
      this.handleDisconnectCleanup();
    }
  },

  async disconnectSerial() {
    this.logTerminal('sys', 'SYSTEM', 'Memutuskan koneksi USB...');
    this.state.isConnected = false;

    try {
      if (this.state.serialReader) {
        await this.state.serialReader.cancel();
        this.state.serialReader = null;
      }
      if (this.state.serialStreamClosed) {
        await this.state.serialStreamClosed.catch(() => {});
        this.state.serialStreamClosed = null;
      }
      if (this.state.serialPort) {
        await this.state.serialPort.close();
        this.state.serialPort = null;
      }
    } catch (err) {
      console.warn('[Bridge] Error saat menutup port:', err);
    }

    this.handleDisconnectCleanup();
    this.logTerminal('sys', 'DISCONNECTED', 'Port USB telah ditutup.');
    this.showToast('USB Serial diputuskan', '🔌');
  },

  handleDisconnectCleanup() {
    this.state.isConnected = false;
    this.state.serialPort = null;
    this.state.serialReader = null;

    const statusPill = document.getElementById('usb-status-pill');
    const statusText = document.getElementById('usb-status-text');
    const btnConnect = document.getElementById('btn-serial-connect');
    const btnText = document.getElementById('btn-serial-text');
    const rxDot = document.getElementById('usb-rx-dot');

    if (statusText) statusText.textContent = 'USB Terputus';
    if (statusPill) statusPill.style.borderColor = 'var(--border-subtle)';
    if (btnConnect) btnConnect.classList.replace('btn-secondary', 'btn-primary');
    if (btnText) btnText.textContent = '🔌 Hubungkan USB Serial';
    if (rxDot) rxDot.classList.remove('active');
  },

  // ==============================================================================
  // DATA PARSER ENGINE: DUAL SUPPORT FOR JSON & CSV
  // ==============================================================================
  parseRawData(rawLine) {
    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];

    // Blink RX LED
    this.blinkRxLed();

    // Update Counter RX
    this.state.rxCount++;
    this.state.lastPacketTime = timeStr;
    const statRx = document.getElementById('stat-rx-count');
    const statLastTime = document.getElementById('stat-last-time');
    if (statRx) statRx.textContent = this.state.rxCount;
    if (statLastTime) statLastTime.textContent = timeStr;

    // Log Raw Line ke Terminal
    this.logTerminal('rx', 'RAW RX', rawLine);

    const mode = this.state.parserMode;
    let parsedRecord = null;
    let formatUsed = null;

    // 1. Coba Parse sebagai JSON
    const looksLikeJson = rawLine.startsWith('{') && rawLine.endsWith('}');
    if (mode === 'json' || (mode === 'auto' && looksLikeJson)) {
      parsedRecord = this.tryParseJson(rawLine);
      if (parsedRecord) formatUsed = 'JSON';
    }

    // 2. Jika bukan JSON, coba Parse sebagai CSV
    if (!parsedRecord && (mode === 'csv' || mode === 'auto')) {
      parsedRecord = this.tryParseCsv(rawLine);
      if (parsedRecord) formatUsed = 'CSV';
    }

    // 3. Jika berhasil diparse
    if (parsedRecord) {
      this.logTerminal(
        formatUsed === 'JSON' ? 'json' : 'csv',
        `PARSED (${formatUsed})`,
        `V: ${parsedRecord.voltase}V | I: ${parsedRecord.arus_listrik}A | P: ${parsedRecord.daya}W | Irr: ${parsedRecord.irradiansi} | Sudut: ${parsedRecord.besar_sudut}°`
      );

      // Update Tampilan Monitor & Dial Sudut
      this.applyTelemetryToMonitor(parsedRecord);

      // Push ke Grafik Realtime
      this.pushToRealtimeChart(parsedRecord);

      // Sinkronisasi ke Supabase jika opsi centang aktif
      const chkAutoSupa = document.getElementById('chk-auto-supabase');
      if (chkAutoSupa && chkAutoSupa.checked) {
        this.pushRecordToSupabase(parsedRecord);
      }
    } else {
      // Baris teks diagnostik / debug log dari mikrokontroler (misal: "[BOOT] Wi-Fi OK")
      this.logTerminal('sys', 'DEVICE LOG', rawLine);
    }
  },

  // Parser JSON Fleksibel
  tryParseJson(line) {
    try {
      const obj = JSON.parse(line);
      const now = new Date();

      // Ekstraksi nilai dengan toleransi beragam alias nama field
      const v = parseFloat(obj.v ?? obj.volt ?? obj.voltage ?? obj.voltase ?? obj.tegangan);
      const i = parseFloat(obj.i ?? obj.curr ?? obj.current ?? obj.arus ?? obj.arus_listrik);
      
      let p = parseFloat(obj.p ?? obj.power ?? obj.daya ?? obj.watt);
      if (isNaN(p) && !isNaN(v) && !isNaN(i)) {
        p = Math.round(v * i * 100) / 100;
      }

      let e = parseFloat(obj.e ?? obj.energy ?? obj.energi ?? obj.energi_listrik ?? obj.kwh);
      if (isNaN(e)) {
        // Akumulasi otomatis: kWh += (P * 5 detik / 3600 / 1000)
        const addKwh = ((isNaN(p) ? 0 : p) * 5) / 3600000;
        this.state.cumulativeEnergy = +(this.state.cumulativeEnergy + addKwh).toFixed(3);
        e = this.state.cumulativeEnergy;
      } else {
        this.state.cumulativeEnergy = e;
      }

      const irr = parseFloat(obj.irr ?? obj.irradiance ?? obj.irradiansi ?? obj.lux ?? obj.matahari ?? 890);
      const deg = parseFloat(obj.deg ?? obj.angle ?? obj.sudut ?? obj.besar_sudut ?? obj.tilt ?? 34.5);
      const dev = obj.device_id || obj.id || obj.device || 'USB-TRACKER';

      if (isNaN(v) && isNaN(i) && isNaN(p)) {
        return null; // Bukan objek telemetri valid
      }

      return {
        waktu_tanggal: now.toISOString().split('T')[0],
        waktu_jam: now.toTimeString().split(' ')[0],
        voltase: isNaN(v) ? 0 : v,
        arus_listrik: isNaN(i) ? 0 : i,
        daya: isNaN(p) ? 0 : p,
        energi_listrik: isNaN(e) ? 0 : e,
        irradiansi: isNaN(irr) ? 0 : irr,
        besar_sudut: isNaN(deg) ? 0 : deg,
        device_id: dev,
        sumber: 'usb_json'
      };
    } catch (e) {
      return null;
    }
  },

  // Parser CSV Cerdas
  tryParseCsv(line) {
    // Tentukan delimiter: koma atau titik koma
    const delimSelect = document.getElementById('csv-delimiter')?.value || 'auto';
    let delimiter = ',';
    if (delimSelect === ';') delimiter = ';';
    else if (delimSelect === 'auto') {
      if (line.includes(';') && !line.includes(',')) delimiter = ';';
      else delimiter = ',';
    }

    const parts = line.split(delimiter).map((s) => s.trim());
    if (parts.length < 2) return null;

    // Jika baris berisi header huruf, catat dan abaikan
    const hasManyLetters = parts.some((p) => /[a-zA-Z]{3,}/.test(p));
    if (hasManyLetters) {
      this.logTerminal('csv', 'CSV HEADER', `Format kolom terdeteksi: [${parts.join(', ')}]`);
      return null;
    }

    // Ambil angka dari setiap item
    const nums = parts.map((p) => parseFloat(p));
    if (nums.some((n) => isNaN(n))) {
      return null; // Bukan deretan angka CSV
    }

    const now = new Date();
    const preset = document.getElementById('csv-preset')?.value || 'v,i,p,e,irr,deg';
    let v = 0, i = 0, p = 0, e = 0, irr = 890, deg = 34.5;

    // Mapping berdasarkan jumlah kolom dan preset
    if (nums.length >= 6) {
      // [V, I, P, E, Irr, Sudut]
      v = nums[0];
      i = nums[1];
      p = nums[2];
      e = nums[3];
      irr = nums[4];
      deg = nums[5];
    } else if (nums.length === 5) {
      // [V, I, P, Irr, Sudut]
      v = nums[0];
      i = nums[1];
      p = nums[2];
      irr = nums[3];
      deg = nums[4];
      const addKwh = (p * 5) / 3600000;
      this.state.cumulativeEnergy = +(this.state.cumulativeEnergy + addKwh).toFixed(3);
      e = this.state.cumulativeEnergy;
    } else if (nums.length === 4) {
      // [V, I, Irr, Sudut]
      v = nums[0];
      i = nums[1];
      p = Math.round(v * i * 100) / 100;
      irr = nums[2];
      deg = nums[3];
      const addKwh = (p * 5) / 3600000;
      this.state.cumulativeEnergy = +(this.state.cumulativeEnergy + addKwh).toFixed(3);
      e = this.state.cumulativeEnergy;
    } else if (nums.length === 2) {
      // [V, I]
      v = nums[0];
      i = nums[1];
      p = Math.round(v * i * 100) / 100;
      e = this.state.cumulativeEnergy;
    } else {
      return null;
    }

    return {
      waktu_tanggal: now.toISOString().split('T')[0],
      waktu_jam: now.toTimeString().split(' ')[0],
      voltase: v,
      arus_listrik: i,
      daya: p,
      energi_listrik: e,
      irradiansi: irr,
      besar_sudut: deg,
      device_id: 'USB-CSV-TRACKER',
      sumber: 'usb_csv'
    };
  },

  // Blink RX Activity LED
  blinkRxLed() {
    const dotUsb = document.getElementById('usb-rx-dot');
    const dotLamp = document.getElementById('terminal-rx-lamp');
    [dotUsb, dotLamp].forEach((el) => {
      if (el) {
        el.classList.add('active');
        setTimeout(() => el.classList.remove('active'), 120);
      }
    });
  },

  // ==============================================================================
  // REAL-TIME GRAFIK DYNAMIC CURVES
  // ==============================================================================
  setChartMetric(metric) {
    this.state.chartMetric = metric;

    ['power', 'vi', 'irr'].forEach((m) => {
      const btn = document.getElementById(`tab-chart-${m}`);
      if (btn) {
        if (m === metric) btn.classList.add('active');
        else btn.classList.remove('active');
      }
    });

    this.renderRealtimeChart();
  },

  pushToRealtimeChart(record) {
    const entry = {
      time: record.waktu_jam,
      voltage: parseFloat(record.voltase),
      current: parseFloat(record.arus_listrik),
      power: parseFloat(record.daya),
      irradiance: parseFloat(record.irradiansi),
      angle: parseFloat(record.besar_sudut)
    };

    this.state.chartHistory.push(entry);
    // Pertahankan maksimal 25 data point terkini
    if (this.state.chartHistory.length > 25) {
      this.state.chartHistory.shift();
    }

    this.renderRealtimeChart();
  },

  renderRealtimeChart() {
    const svg = document.getElementById('realtime-telemetry-svg');
    if (!svg) return;

    const data = this.state.chartHistory;
    if (data.length < 2) return;

    const metric = this.state.chartMetric;
    const width = 400;
    const height = 150;
    const padL = 25;
    const padR = 20;
    const padT = 20;
    const padB = 25;

    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    let values1 = [];
    let values2 = [];
    let unit1 = 'W';
    let unit2 = '';
    let label1 = 'Daya';

    if (metric === 'power') {
      values1 = data.map((d) => d.power);
      unit1 = 'W';
      label1 = 'Daya';
    } else if (metric === 'vi') {
      values1 = data.map((d) => d.voltage);
      values2 = data.map((d) => d.current);
      unit1 = 'V';
      unit2 = 'A';
      label1 = 'Voltase & Arus';
    } else if (metric === 'irr') {
      values1 = data.map((d) => d.irradiance);
      values2 = data.map((d) => d.angle);
      unit1 = 'W/m²';
      unit2 = '°';
      label1 = 'Iradiasi & Sudut';
    }

    // Min & Max calculations
    const min1 = Math.min(...values1);
    const max1 = Math.max(...values1);
    const range1 = max1 - min1 === 0 ? 1 : max1 - min1;
    const avg1 = (values1.reduce((a, b) => a + b, 0) / values1.length).toFixed(1);
    const latest1 = values1[values1.length - 1];

    // Update footer stats
    const statLatest = document.getElementById('chart-stat-latest');
    const statMax = document.getElementById('chart-stat-max');
    const statAvg = document.getElementById('chart-stat-avg');

    if (statLatest) statLatest.textContent = `Terkini: ${latest1} ${unit1}`;
    if (statMax) statMax.textContent = `Puncak: ${max1} ${unit1}`;
    if (statAvg) statAvg.textContent = `Rata-rata: ${avg1} ${unit1}`;

    const getX = (idx) => padL + (idx / (data.length - 1)) * plotW;
    const getY1 = (val) => padT + plotH - ((val - min1) / range1) * plotH;

    // Build Curve Path 1 (Smooth Bezier)
    let pathD1 = `M ${getX(0)},${getY1(values1[0])}`;
    for (let i = 1; i < values1.length; i++) {
      const prevX = getX(i - 1);
      const prevY = getY1(values1[i - 1]);
      const curX = getX(i);
      const curY = getY1(values1[i]);
      const cpX1 = prevX + (curX - prevX) / 2;
      const cpY1 = prevY;
      const cpX2 = cpX1;
      const cpY2 = curY;
      pathD1 += ` C ${cpX1},${cpY1} ${cpX2},${cpY2} ${curX},${curY}`;
    }

    const areaD1 = `${pathD1} L ${getX(values1.length - 1)},${padT + plotH} L ${getX(0)},${padT + plotH} Z`;

    const areaPath = document.getElementById('rt-area-path-1');
    const linePath1 = document.getElementById('rt-line-path-1');
    const linePath2 = document.getElementById('rt-line-path-2');
    const dotsGroup = document.getElementById('rt-dots-group');

    if (areaPath) areaPath.setAttribute('d', areaD1);
    if (linePath1) linePath1.setAttribute('d', pathD1);

    // Optional Curve 2 (if metric has secondary dimension)
    if (values2.length > 0) {
      const min2 = Math.min(...values2);
      const max2 = Math.max(...values2);
      const range2 = max2 - min2 === 0 ? 1 : max2 - min2;
      const getY2 = (val) => padT + plotH - ((val - min2) / range2) * plotH;

      let pathD2 = `M ${getX(0)},${getY2(values2[0])}`;
      for (let i = 1; i < values2.length; i++) {
        const prevX = getX(i - 1);
        const prevY = getY2(values2[i - 1]);
        const curX = getX(i);
        const curY = getY2(values2[i]);
        pathD2 += ` L ${curX},${curY}`;
      }
      if (linePath2) {
        linePath2.setAttribute('d', pathD2);
        linePath2.style.display = 'block';
      }
    } else {
      if (linePath2) linePath2.style.display = 'none';
    }

    // Render dot on the latest point
    if (dotsGroup) {
      dotsGroup.innerHTML = '';
      const lastIdx = values1.length - 1;
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', getX(lastIdx));
      circle.setAttribute('cy', getY1(values1[lastIdx]));
      circle.setAttribute('r', '4.5');
      circle.setAttribute('fill', '#34d399');
      circle.setAttribute('stroke', '#ffffff');
      circle.setAttribute('stroke-width', '1.5');
      dotsGroup.appendChild(circle);
    }
  },

  // ==============================================================================
  // PUSH KE SUPABASE DATABASE
  // ==============================================================================
  async pushRecordToSupabase(record) {
    const res = await window.SolarDB.insertTelemetry(record);

    if (res.success) {
      this.state.syncedCount++;
      const statSync = document.getElementById('stat-synced-count');
      if (statSync) statSync.textContent = this.state.syncedCount;

      const recordId = res.data?.id ? `#${res.data.id}` : 'OK';
      this.logTerminal('sync', 'SUPABASE SYNC', `Tersimpan di Cloud Supabase (${recordId})`);

      // Tambahkan ke tabel riwayat lokal
      this.state.recentLogs.unshift(res.data || record);
      if (this.state.recentLogs.length > 30) this.state.recentLogs.pop();
      this.renderLogsTable(this.state.recentLogs);
    } else {
      this.logTerminal('err', 'SYNC BUFFER', `Disimpan di buffer lokal (${res.error || res.message || 'offline'})`);
      this.state.recentLogs.unshift(record);
      this.renderLogsTable(this.state.recentLogs);
    }
  },

  // ==============================================================================
  // UPDATE UI LIVE MONITOR
  // ==============================================================================
  applyTelemetryToMonitor(row) {
    if (!row) return;

    // Power kW & Watt
    const elPower = document.getElementById('val-power');
    const elWatt = document.getElementById('val-power-watt');
    const dayaNum = parseFloat(row.daya) || 0;
    if (elPower) elPower.textContent = (dayaNum / 1000).toFixed(2);
    if (elWatt) elWatt.textContent = `${dayaNum.toFixed(1)} W`;

    // Voltage
    const elVoltage = document.getElementById('val-voltage');
    if (elVoltage) elVoltage.textContent = parseFloat(row.voltase).toFixed(1);

    // Current
    const elCurrent = document.getElementById('val-current');
    if (elCurrent) elCurrent.textContent = parseFloat(row.arus_listrik).toFixed(2);

    // Irradiance
    const elIrr = document.getElementById('val-irradiance');
    if (elIrr) elIrr.textContent = Math.round(row.irradiansi);

    // Dials & Needle Sudut
    const angle = parseFloat(row.besar_sudut) || 0;
    const elElevation = document.getElementById('val-elevation');
    const elNeedle = document.getElementById('elevation-needle');
    const elAzimuth = document.getElementById('val-azimuth');
    const elAzimuthNeedle = document.getElementById('azimuth-needle');

    if (elElevation) elElevation.textContent = `${angle.toFixed(1)}°`;
    if (elNeedle) elNeedle.style.transform = `rotate(${angle}deg)`;

    const azDeg = (120 + angle * 0.8).toFixed(1);
    if (elAzimuth) elAzimuth.textContent = `${azDeg}° SE`;
    if (elAzimuthNeedle) elAzimuthNeedle.style.transform = `rotate(${azDeg}deg)`;
  },

  // ==============================================================================
  // TERMINAL RAW STREAM CONSOLE
  // ==============================================================================
  logTerminal(badgeClass, badgeText, message) {
    const body = document.getElementById('terminal-body');
    if (!body) return;

    const now = new Date();
    const timeStr = now.toTimeString().split(' ')[0];

    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `
      <span class="log-time">${timeStr}</span>
      <span class="log-badge ${badgeClass}">${badgeText}</span>
      <span class="log-text">${this.escapeHtml(message)}</span>
    `;

    body.appendChild(entry);
    this.state.terminalLines.push(`[${timeStr}] [${badgeText}] ${message}`);

    // Batasi histori baris agar memori tetap ringan
    if (body.children.length > 150) {
      body.removeChild(body.firstChild);
    }
    if (this.state.terminalLines.length > 300) {
      this.state.terminalLines.shift();
    }

    // Auto-scroll
    const chkScroll = document.getElementById('chk-autoscroll');
    if (chkScroll && chkScroll.checked) {
      body.scrollTop = body.scrollHeight;
    }
  },

  clearTerminal() {
    const body = document.getElementById('terminal-body');
    if (body) {
      body.innerHTML = '';
      this.logTerminal('sys', 'SYSTEM', 'Terminal log dibersihkan.');
    }
    this.state.terminalLines = [];
  },

  copyTerminalLogs() {
    if (this.state.terminalLines.length === 0) {
      this.showToast('Terminal masih kosong', '⚠️');
      return;
    }
    const text = this.state.terminalLines.join('\n');
    navigator.clipboard.writeText(text).then(() => {
      this.showToast('Log terminal disalin ke clipboard!', '📋');
    });
  },

  escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  },

  // ==============================================================================
  // UJI SIMULASI PAKET CEPAT (JSON & CSV)
  // ==============================================================================
  simulatePacket(type) {
    const v = +(380 + (Math.random() * 15 - 7.5)).toFixed(1);
    const i = +(11.5 + (Math.random() * 2)).toFixed(2);
    const p = +(v * i).toFixed(1);
    const irr = Math.round(850 + (Math.random() * 80 - 40));
    const deg = +(30 + (Math.random() * 15)).toFixed(1);
    const e = +(this.state.cumulativeEnergy + 0.005).toFixed(2);

    if (type === 'json') {
      const sampleJson = JSON.stringify({
        voltase: v,
        arus: i,
        daya: p,
        energi: e,
        irradiansi: irr,
        sudut: deg,
        device: 'ESP32-TEST-PACKET'
      });
      this.parseRawData(sampleJson);
    } else if (type === 'csv') {
      const sampleCsv = `${v}, ${i}, ${p}, ${e}, ${irr}, ${deg}`;
      this.parseRawData(sampleCsv);
    }
  },

  // ==============================================================================
  // RIWAYAT DATA & SUPABASE HELPERS
  // ==============================================================================
  async checkSupabaseConnection() {
    const statusText = document.getElementById('supa-status-text');
    const pulseDot = document.getElementById('supa-pulse-dot');

    if (statusText) statusText.textContent = 'Memeriksa Supabase...';
    const res = await window.SolarDB.testConnection();

    if (res.success) {
      this.state.supabaseStatus = 'connected';
      if (statusText) statusText.textContent = 'Supabase Cloud Siap';
      if (pulseDot) pulseDot.className = 'pulse-dot';
      this.logTerminal('sys', 'SUPABASE', 'Database Supabase terhubung & siap menerima telemetri.');
    } else if (res.status === 'table_missing') {
      this.state.supabaseStatus = 'table_missing';
      if (statusText) statusText.textContent = 'Tabel Belum Dibuat';
      if (pulseDot) pulseDot.className = 'pulse-dot warning';
      this.logTerminal('err', 'SUPABASE', 'Tabel solar_telemetry belum dibuat di Supabase (jalankan SQL Schema).');
    } else {
      this.state.supabaseStatus = 'offline';
      if (statusText) statusText.textContent = 'Buffer Lokal (Siaga)';
      if (pulseDot) pulseDot.className = 'pulse-dot danger';
      this.logTerminal('sys', 'SUPABASE', 'Supabase offline/siaga. Data otomatis disimpan di buffer lokal.');
    }
  },

  async loadRecentLogs() {
    const logs = await window.SolarDB.fetchRecent(25);
    this.state.recentLogs = logs || [];
    this.renderLogsTable(this.state.recentLogs);
    if (this.state.recentLogs.length > 0) {
      this.applyTelemetryToMonitor(this.state.recentLogs[0]);
    }
  },

  renderLogsTable(logs) {
    const tbody = document.getElementById('telemetry-tbody');
    const badgeCount = document.getElementById('log-count-badge');
    if (!tbody) return;

    if (badgeCount) badgeCount.textContent = `${logs.length} Data`;

    if (logs.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" style="text-align: center; color: var(--text-dim); padding: 24px;">
            Belum ada data telemetri tersimpan. Hubungkan USB atau lakukan simulasi tes data.
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = logs
      .map((row) => {
        const pKw = (parseFloat(row.daya) / 1000).toFixed(2);
        const sourceLabel = row.sumber?.includes('usb')
          ? `<span class="source-tag hardware">USB Serial</span>`
          : `<span class="source-tag api">${this.escapeHtml(row.sumber || 'web')}</span>`;

        return `
          <tr>
            <td>
              <div style="font-weight: 600; color: var(--text-primary);">${row.waktu_jam || '-'}</div>
              <div style="font-size: 0.72rem; color: var(--text-dim);">${row.waktu_tanggal || '-'}</div>
            </td>
            <td style="color: #38bdf8; font-weight: 600;">${row.voltase} V</td>
            <td style="color: #fbbf24; font-weight: 600;">${row.arus_listrik} A</td>
            <td>
              <span class="power-badge">${pKw} kW</span>
              <span style="font-size: 0.72rem; color: var(--text-dim); display: block;">${row.daya} W</span>
            </td>
            <td>${row.energi_listrik} kWh</td>
            <td>${row.irradiansi} W/m²</td>
            <td style="color: var(--green-accent); font-weight: 600;">${row.besar_sudut}°</td>
            <td>${sourceLabel}</td>
            <td>
              <button class="btn-action-delete" onclick="AdminApp.deleteLogRecord(${row.id})" title="Hapus baris ini">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
              </button>
            </td>
          </tr>
        `;
      })
      .join('');
  },

  async deleteLogRecord(id) {
    if (!confirm('Hapus baris data telemetri ini?')) return;
    await window.SolarDB.deleteTelemetry(id);
    this.state.recentLogs = this.state.recentLogs.filter((r) => r.id !== id);
    this.renderLogsTable(this.state.recentLogs);
    this.showToast('Baris data dihapus', '🗑️');
  },

  setupRealtimeListener() {
    window.SolarDB.subscribeRealtime((newRecord) => {
      // Jika data masuk dari luar (misal ESP32 mandiri lewat Wi-Fi)
      if (newRecord.sumber !== 'usb_serial' && newRecord.sumber !== 'usb_json' && newRecord.sumber !== 'usb_csv') {
        this.state.recentLogs.unshift(newRecord);
        if (this.state.recentLogs.length > 30) this.state.recentLogs.pop();
        this.renderLogsTable(this.state.recentLogs);
        this.applyTelemetryToMonitor(newRecord);
        this.pushToRealtimeChart(newRecord);
        this.logTerminal('sync', 'REALTIME CLOUD', `Data masuk dari ${newRecord.device_id || 'remote'}`);
      }
    });
  },

  // ==============================================================================
  // FORM MANUAL & FALLBACK
  // ==============================================================================
  generateRealisticData() {
    const v = +(380 + (Math.random() * 20 - 10)).toFixed(1);
    const i = +(11.5 + (Math.random() * 2.5)).toFixed(2);
    const p = +(v * i).toFixed(1);
    const irr = Math.round(820 + (Math.random() * 140));
    const angle = +(25 + (Math.random() * 35)).toFixed(1);

    document.getElementById('input-voltase').value = v;
    document.getElementById('input-arus').value = i;
    document.getElementById('input-daya').value = p;
    document.getElementById('input-irradiansi').value = irr;
    document.getElementById('input-sudut').value = angle;
    this.showToast('Form diisi data acak realistis', '✨');
  },

  toggleSection(sectionId) {
    const card = document.getElementById(sectionId);
    if (card) card.classList.toggle('collapsed');
  },

  bindEvents() {
    // Form Input Manual submit handler
    const form = document.getElementById('solar-input-form');
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const record = {
          waktu_tanggal: document.getElementById('input-tanggal').value,
          waktu_jam: document.getElementById('input-jam').value,
          voltase: parseFloat(document.getElementById('input-voltase').value),
          arus_listrik: parseFloat(document.getElementById('input-arus').value),
          daya: parseFloat(document.getElementById('input-daya').value),
          energi_listrik: parseFloat(document.getElementById('input-energi').value),
          irradiansi: parseFloat(document.getElementById('input-irradiansi').value),
          besar_sudut: parseFloat(document.getElementById('input-sudut').value),
          device_id: document.getElementById('input-device-id').value || 'MANUAL-WEB-01',
          sumber: 'manual_admin'
        };

        this.applyTelemetryToMonitor(record);
        this.pushToRealtimeChart(record);
        await this.pushRecordToSupabase(record);
        this.showToast('Data manual berhasil disimpan ke Supabase!', '✓');
      });
    }

    // Auto calculate Power on manual form
    const inV = document.getElementById('input-voltase');
    const inI = document.getElementById('input-arus');
    const inP = document.getElementById('input-daya');
    const autoCalc = () => {
      const v = parseFloat(inV?.value) || 0;
      const i = parseFloat(inI?.value) || 0;
      if (inP) inP.value = Math.round(v * i * 10) / 10;
    };
    if (inV) inV.addEventListener('input', autoCalc);
    if (inI) inI.addEventListener('input', autoCalc);
  },

  // ==============================================================================
  // EXPORT TOOLS
  // ==============================================================================
  exportCSV() {
    const logs = this.state.recentLogs;
    if (!logs || logs.length === 0) {
      this.showToast('Tidak ada data untuk diekspor', '⚠️');
      return;
    }

    const headers = ['ID', 'Tanggal', 'Jam', 'Voltase(V)', 'Arus(A)', 'Daya(W)', 'Energi(kWh)', 'Irradiansi(W/m2)', 'BesarSudut(deg)', 'Sumber'];
    const rows = logs.map((l) => [
      l.id,
      l.waktu_tanggal,
      l.waktu_jam,
      l.voltase,
      l.arus_listrik,
      l.daya,
      l.energi_listrik,
      l.irradiansi,
      l.besar_sudut,
      l.sumber
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `heliotrack_bridge_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    this.showToast('File CSV berhasil diunduh', '📥');
  },

  // ==============================================================================
  // MODAL & TOAST
  // ==============================================================================
  openModal(modalId) {
    const m = document.getElementById(modalId);
    if (m) m.classList.add('active');
  },

  closeModal(modalId) {
    const m = document.getElementById(modalId);
    if (m) m.classList.remove('active');
  },

  copySchemaSQL() {
    const code = document.getElementById('sql-code-box')?.innerText;
    if (code) {
      navigator.clipboard.writeText(code).then(() => {
        this.showToast('SQL Schema berhasil disalin ke clipboard!', '📋');
      });
    }
  },

  showToast(message, icon = '✓') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<span>${icon}</span> <span>${this.escapeHtml(message)}</span>`;

    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.25s ease';
      setTimeout(() => toast.remove(), 250);
    }, 2800);
  }
};

// Start application when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  AdminApp.init();
});
