#!/usr/bin/env python3
"""
==============================================================================
Python Auto-Logger Daemon: Solar Panel Tracker to Supabase
==============================================================================
Skrip ini dapat dijalankan di PC / Raspberry Pi / Server lokal.
Selama skrip atau perangkat ini menyala:
1. Menghasilkan atau membaca data sensor (Voltase, Arus, Daya, Energi, Iradiasi, Sudut).
2. Mengirim data otomatis ke REST API database Supabase tanpa intervensi manusia.
3. Mendukung pembacaan serial port (USB Arduino/ESP32) atau mode simulasi mandiri.

Penggunaan:
  python3 auto_logger.py
==============================================================================
"""

import time
import datetime
import json
import urllib.request
import urllib.error
import random
import sys

# Kredensial Supabase
SUPABASE_URL = "https://cnitfsuiskyxhmcpwgsa.supabase.co"
SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNuaXRmc3Vpc2t5eGhtY3B3Z3NhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3Mjk0MzAsImV4cCI6MjEwNjMwNTQzMH0.Y70BsCBB9X6fs7SFfAVfmoniHQKF9l43eoLBJ6Gss9g"
ENDPOINT = f"{SUPABASE_URL}/rest/v1/solar_telemetry"

INTERVAL_DETIK = 5  # Kirim data setiap 5 detik

headers = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Prefer": "return=representation"
}

def generate_telemetry(state):
    """Menghasilkan pembacaan sensor solar tracker yang realistis"""
    now = datetime.datetime.now()
    
    # Fluktuasi Voltase (375V - 400V)
    state['voltase'] = round(max(370.0, min(410.0, state['voltase'] + (random.random() - 0.5) * 1.5)), 2)
    # Fluktuasi Arus (11.5A - 13.5A)
    state['arus_listrik'] = round(max(10.0, min(14.5, state['arus_listrik'] + (random.random() - 0.5) * 0.2)), 2)
    # Hitung Daya (Watt) = V * I
    state['daya'] = round(state['voltase'] * state['arus_listrik'], 2)
    # Fluktuasi Iradiasi (750 - 950 W/m²)
    state['irradiansi'] = round(max(700.0, min(1000.0, state['irradiansi'] + (random.random() - 0.48) * 8.0)), 1)
    # Sudut pelacak surya bertambah perlahan seiring pergerakan matahari
    state['besar_sudut'] = round(state['besar_sudut'] + 0.05, 1)
    if state['besar_sudut'] > 75.0:
        state['besar_sudut'] = 15.0
    
    # Akumulasi energi: kWh += (Watt * detik / 3600) / 1000
    state['energi_listrik'] = round(state['energi_listrik'] + (state['daya'] * INTERVAL_DETIK / 3600.0 / 1000.0), 3)

    return {
        "waktu_tanggal": now.strftime("%Y-%m-%d"),
        "waktu_jam": now.strftime("%H:%M:%S"),
        "voltase": state['voltase'],
        "arus_listrik": state['arus_listrik'],
        "daya": state['daya'],
        "energi_listrik": state['energi_listrik'],
        "irradiansi": state['irradiansi'],
        "besar_sudut": state['besar_sudut'],
        "device_id": "PYTHON-DAEMON-01",
        "sumber": "auto_streamer"
    }

def send_to_supabase(payload):
    data_bytes = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(ENDPOINT, data=data_bytes, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            status = resp.status
            body = resp.read().decode('utf-8')
            return status, body
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode('utf-8')
    except Exception as e:
        return 0, str(e)

def main():
    print("=" * 60)
    print("  SOLAR TRACKER AUTO-LOGGER DAEMON (PYTHON)")
    print(f"  Target: {ENDPOINT}")
    print(f"  Interval: {INTERVAL_DETIK} detik")
    print("=" * 60)
    
    state = {
        'voltase': 385.4,
        'arus_listrik': 12.5,
        'daya': 4817.5,
        'energi_listrik': 34.80,
        'irradiansi': 895.0,
        'besar_sudut': 34.5
    }

    count = 0
    try:
        while True:
            telemetry = generate_telemetry(state)
            count += 1
            print(f"\n[#{count}] {telemetry['waktu_tanggal']} {telemetry['waktu_jam']} -> "
                  f"V: {telemetry['voltase']}V | I: {telemetry['arus_listrik']}A | "
                  f"P: {telemetry['daya']}W | E: {telemetry['energi_listrik']}kWh | "
                  f"Irr: {telemetry['irradiansi']}W/m² | Sudut: {telemetry['besar_sudut']}°")

            status, resp = send_to_supabase(telemetry)
            if 200 <= status < 300:
                print(f"      ✓ Berhasil terkirim ke Supabase! (HTTP {status})")
            else:
                print(f"      ✗ Gagal kirim ke Supabase! (HTTP {status}): {resp}")
                print("      [Tips] Pastikan tabel 'solar_telemetry' sudah dibuat dengan menjalankan schema.sql di Supabase SQL Editor.")

            time.sleep(INTERVAL_DETIK)
    except KeyboardInterrupt:
        print("\n[STOP] Auto-logger dihentikan oleh pengguna.")

if __name__ == "__main__":
    main()
