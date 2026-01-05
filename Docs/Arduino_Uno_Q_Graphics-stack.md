DIY-ECG / Arduino Uno Q - Graphics and System Notes
===================================================

System
------
- Hardware: Qualcomm Dragonwing(TM) QRB2210 (Quad-Core Cortex-A53, Adreno GPU)
- OS: Debian GNU/Linux 13 (trixie), aarch64
- Kernel: 6.16.7
- Desktop: XFCE (optional)
- Browser: Chromium 141 (Debian build)

1. Role of Ozone
----------------
- Ozone is Chromium's **platform abstraction layer**
- It decouples Chromium from X11, Wayland, DRM/KMS, headless
- Available in Debian Chromium:
  - ozone-platform=x11
  - ozone-platform=wayland
- ozone-platform=drm is **not available**, because it is not built in

-> "Invalid ozone platform: drm" is a **build feature limit**, not an error.

--------------------------------------------------------------------------

2. GPU and graphics stack
-------------------------
Active render path:

Chromium
 -> WebGL / Canvas
   -> ANGLE
     -> OpenGL ES 3.1
       -> EGL
         -> Mesa 25.2.x (freedreno / msm)
           -> Adreno GPU (FD702)
             -> Display (via X11)

- WebGL & WebGL2: hardware accelerated
- Compositing & rasterization: hardware accelerated
- Video decode/encode: software only (irrelevant for ECG)
- No GPU crashes, stable output

--------------------------------------------------------------------------

4. Role of the X server today
-----------------------------
Xorg (version 21.1.16) is **no longer the renderer**, but provides:
- Window management
- Keyboard/mouse input
- Presentation of completed GPU buffers

Key points:
- Rendering happens **directly on the GPU**
- X11 is only the transport/windowing layer
- X11-minimal (xinit) ~= DRM/KMS for this use case

Rule of thumb:
"X provides windows - Chromium + GPU provide graphics."

--------------------------------------------------------------------------

5. GLX vs. EGL
--------------
- GLX:
  - X11 specific
  - legacy
  - not Wayland/DRM capable

- EGL:
  - platform neutral
  - standard for embedded, ARM, Chromium
  - supports X11, Wayland, DRM/KMS, headless
  - uses OpenGL ES

Chromium uses **EGL**, not GLX.
glxinfo is still useful as a diagnostic tool.

--------------------------------------------------------------------------

6. Version checks
-----------------
- X server:
  Xorg -version
  /var/log/Xorg.0.log

- Mesa (running):
  glxinfo | grep "OpenGL version"
  eglinfo | grep "EGL version"

- Mesa (installed):
  dpkg -l | grep mesa

glxinfo / eglinfo do **not** show the X server version.

--------------------------------------------------------------------------

7. Operation without a desktop
------------------------------
- XFCE can be fully disabled
- Stop lightdm:
  sudo systemctl stop lightdm

- Start X without a desktop:
  xinit chromium ...

- Running Chromium directly without X (DRM) would be possible in principle,
  but it is **not built into** Debian Chromium.

Recommendation:
-> X11 without a desktop (xinit + Chromium kiosk)

--------------------------------------------------------------------------

8. Autostart Arduino IDE / App Lab
----------------------------------
Autostart does **not come from Linux itself**, but from:
- XFCE session (xfce4-session.xml)
- possibly a systemd service
- possibly /etc/xdg/autostart

Relevant path:
~/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-session.xml

-> Remove Arduino entries there or reset the file.

--------------------------------------------------------------------------

9. Keyboard on CLI
------------------
- setxkbmap only applies to X
- The CLI needs package: kbd

Install:
  sudo apt install kbd

Temporary:
  sudo loadkeys de

Persistent:
  sudo localectl set-keymap de-nodeadkeys

--------------------------------------------------------------------------

10. Chromium graphics overview (Blink, Skia, Ozone, etc.)
--------------------------------------------------------
How the main pieces fit together:

- Blink: Chromium's rendering engine; parses HTML/CSS, runs layout, and builds
  the render tree for painting.
- Skia: 2D graphics library used by Blink/Viz for drawing text, shapes, and
  images; targets GPU or CPU backends.
- Ozone: platform abstraction layer; selects the windowing and input backend
  (X11/Wayland/DRM) and provides surfaces for rendering.
- Viz (compositor): assembles layers, applies transforms/opacity, and submits
  frames for display.
- ANGLE: translates WebGL/OpenGL ES calls to the platform's graphics API
  (OpenGL ES via EGL on this device).
- EGL/Mesa/Driver: the platform GPU stack that allocates buffers, executes
  shaders, and presents frames.

End-to-end flow (simplified):
Blink builds layers -> Skia draws -> Viz composites -> ANGLE/EGL/Mesa render ->
Ozone presents via X11 to the display.

For this project, WebGL plotting goes through ANGLE and the Adreno GPU, while
Skia handles UI text and 2D elements.

==========================================================================
