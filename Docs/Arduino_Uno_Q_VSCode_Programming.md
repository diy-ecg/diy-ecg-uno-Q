DIY-ECG / Arduino Uno Q - Programming with VS Code
==================================================

Overview
--------
This project runs on the Arduino Uno Q with two parts:
- MCU sketch: `sketch/sketch.ino` (samples the ECG and exposes RPC frames)
- Linux side: `python/` (streams data to the Web UI)

VS Code is used to edit both parts, while the Arduino CLI handles build/upload.

Prerequisites
-------------
- VS Code installed on the Uno Q (or your dev machine connected to it)
- Arduino CLI installed (`arduino-cli`)
- Board core for Arduino Uno Q installed

Open the project
----------------
1. Start VS Code.
2. Open the folder: `~/ArduinoApps/diy-ecg`.
3. Use the integrated terminal for all build/upload commands.

Build and upload the MCU sketch
-------------------------------
1. Detect the board and port:
   ```bash
   arduino-cli board list
   ```
   You should see something like:
   - Board: Arduino UNO Q
   - FQBN: `arduino:zephyr:unoq`
   - Port: the network/USB port reported by the CLI

2. Compile the sketch:
   ```bash
   arduino-cli compile --fqbn arduino:zephyr:unoq sketch
   ```

3. Upload it to the board (replace `<PORT>` with the port from step 1):
   ```bash
   arduino-cli upload -p <PORT> --fqbn arduino:zephyr:unoq sketch
   ```

4. Optional: open a serial monitor:
   ```bash
   arduino-cli monitor -p <PORT>
   ```

Run the Linux app and Web UI
----------------------------
After the MCU sketch is uploaded, start the Linux-side app from VS Code:

```bash
arduino-app-cli app start .
```

Then open the UI in a browser:
- Local on the Uno Q: `http://localhost:7000`
- With port forwarding: `http://127.0.0.1:7000`

Where to edit
-------------
- MCU code: `sketch/sketch.ino`
- Linux data pipeline: `python/main.py` and `python/data_stream.py`
- Web UI: `python/webui/app.js`, `index.html`, `styles.css`

Troubleshooting quick checks
----------------------------
- Board not detected: re-run `arduino-cli board list`
- Wrong port: verify the port reported by the CLI
- Upload fails: ensure the Uno Q is powered and connected
