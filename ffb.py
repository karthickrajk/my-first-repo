"""Force feedback for steering wheels, used by the DriveReady Windows app.

Browsers cannot drive a wheel's motor, so the game page works out what the
driver should feel and sends it here (through pywebview); this module plays it
on the wheel with SDL2's haptic API (DirectInput force feedback on Windows,
which Logitech G29/G920/G923 and Thrustmaster wheels support).

Effects, all running on the wheel itself:
  spring  - pulls the wheel back to centre (stronger at speed)
  damper  - resists turning (heavy when parked, light at speed)
  rumble  - a sine vibration (rough ground, off the road)
  jolt    - a short push (collisions, cones, stalling)

One worker thread owns SDL; the page only updates target values.
"""
import threading
import time

try:
    import sdl2
except Exception:  # PySDL2 or its SDL2 library missing: force feedback is simply unavailable
    sdl2 = None

S16 = 32767
WANTED = ("spring", "damper", "rumble")


def _fraction(v):
    try:
        return max(0.0, min(1.0, float(v)))
    except (TypeError, ValueError):
        return 0.0


class ForceFeedback:
    def __init__(self):
        self._lock = threading.Lock()
        self._target = {"spring": 0.0, "damper": 0.0, "rumble": 0.0, "gain": 0.6, "invert": False, "enabled": False}
        self._jolt = None          # (strength, direction) waiting to be played
        self._stop = threading.Event()
        self.status = "starting"
        self.device = ""
        self._thread = threading.Thread(target=self._run, name="force-feedback", daemon=True)
        self._thread.start()

    # ---- called from the page (pywebview's API thread)
    def set(self, values):
        if not isinstance(values, dict):
            return
        with self._lock:
            for k in WANTED + ("gain",):
                if k in values:
                    self._target[k] = _fraction(values[k])
            for k in ("invert", "enabled"):
                if k in values:
                    self._target[k] = bool(values[k])
            if values.get("jolt"):
                self._jolt = (_fraction(values["jolt"]), -1 if values.get("dir", 1) < 0 else 1)

    def info(self):
        return {"available": self.status == "ready", "status": self.status, "device": self.device}

    def stop(self):
        self._stop.set()
        self._thread.join(timeout=2)

    # ---- worker thread
    def _run(self):
        if sdl2 is None:
            self.status = "SDL2 is not installed"
            return
        if sdl2.SDL_Init(sdl2.SDL_INIT_JOYSTICK | sdl2.SDL_INIT_HAPTIC) != 0:
            self.status = "SDL could not start: " + sdl2.SDL_GetError().decode(errors="replace")
            return
        dev = None
        next_scan = 0.0
        try:
            while not self._stop.is_set():
                if dev is None and time.monotonic() >= next_scan:
                    dev = self._open()
                    next_scan = time.monotonic() + 2.0   # look again later if nothing is plugged in
                if dev is not None and not dev.apply(self._snapshot()):
                    dev.close()                          # wheel unplugged: start looking again
                    dev = None
                    self.status, self.device = "no force feedback wheel found", ""
                time.sleep(1 / 60)
        finally:
            if dev is not None:
                dev.close()
            sdl2.SDL_Quit()

    def _snapshot(self):
        with self._lock:
            t = dict(self._target)
            jolt, self._jolt = self._jolt, None
        return t, jolt

    def _open(self):
        for i in range(sdl2.SDL_NumHaptics()):
            h = sdl2.SDL_HapticOpen(i)
            if not h:
                continue
            caps = sdl2.SDL_HapticQuery(h)
            if caps & (sdl2.SDL_HAPTIC_SPRING | sdl2.SDL_HAPTIC_CONSTANT):
                name = (sdl2.SDL_HapticName(i) or b"").decode(errors="replace")
                dev = _Wheel(h, caps)
                self.status, self.device = "ready", name
                return dev
            sdl2.SDL_HapticClose(h)
        self.status, self.device = "no force feedback wheel found", ""
        return None


class _Wheel:
    """One opened haptic device and the effects created on it."""

    def __init__(self, h, caps):
        self.h, self.caps = h, caps
        self.effects = {}   # name -> (effect id, SDL_HapticEffect)
        self.sent = {}
        if caps & sdl2.SDL_HAPTIC_AUTOCENTER:
            sdl2.SDL_HapticSetAutocenter(h, 0)   # the game supplies its own centring
        if caps & sdl2.SDL_HAPTIC_GAIN:
            sdl2.SDL_HapticSetGain(h, 100)
        self._make("spring", sdl2.SDL_HAPTIC_SPRING, self._condition)
        self._make("damper", sdl2.SDL_HAPTIC_DAMPER, self._condition)
        self._make("rumble", sdl2.SDL_HAPTIC_SINE, self._sine)
        self._make("jolt", sdl2.SDL_HAPTIC_CONSTANT, self._constant)
        for name in ("spring", "damper", "rumble"):
            if name in self.effects:
                sdl2.SDL_HapticRunEffect(h, self.effects[name][0], 1)

    def _make(self, name, kind, build):
        if not self.caps & kind:
            return
        e = sdl2.SDL_HapticEffect()
        e.type = kind
        build(e, kind, 0)
        eid = sdl2.SDL_HapticNewEffect(self.h, e)
        if eid >= 0:
            self.effects[name] = (eid, e)

    @staticmethod
    def _condition(e, kind, level, invert=False):
        c = e.condition
        c.type = kind
        c.length = sdl2.SDL_HAPTIC_INFINITY
        for k in range(3):
            c.right_sat[k] = c.left_sat[k] = 0xFFFF
            c.right_coeff[k] = c.left_coeff[k] = int(S16 * level)
            c.deadband[k] = 0
            c.center[k] = 0

    @staticmethod
    def _sine(e, kind, level, invert=False):
        p = e.periodic
        p.type = kind
        p.direction.type = sdl2.SDL_HAPTIC_CARTESIAN
        p.direction.dir[0] = 1
        p.length = sdl2.SDL_HAPTIC_INFINITY
        p.period = 70          # ms: a coarse road vibration
        p.magnitude = int(S16 * level)

    @staticmethod
    def _constant(e, kind, level, invert=False):
        k = e.constant
        k.type = kind
        k.direction.type = sdl2.SDL_HAPTIC_CARTESIAN
        k.direction.dir[0] = -1 if invert else 1
        k.length = 160         # ms
        k.level = int(S16 * level)

    def _update(self, name, level, invert=False):
        if name not in self.effects:
            return True
        level = round(level, 3)
        if self.sent.get(name) == (level, invert):
            return True
        eid, e = self.effects[name]
        builder = {"spring": self._condition, "damper": self._condition, "rumble": self._sine, "jolt": self._constant}[name]
        builder(e, e.type, level, invert)
        if sdl2.SDL_HapticUpdateEffect(self.h, eid, e) < 0:
            return False
        self.sent[name] = (level, invert)
        return True

    def apply(self, snapshot):
        t, jolt = snapshot
        on, gain = t["enabled"], t["gain"]
        ok = all(self._update(n, t[n] * gain if on else 0.0) for n in WANTED)
        if ok and jolt and on and "jolt" in self.effects:
            strength, direction = jolt
            ok = self._update("jolt", strength * gain, (direction < 0) != t["invert"])
            ok = ok and sdl2.SDL_HapticRunEffect(self.h, self.effects["jolt"][0], 1) >= 0
        return ok

    def close(self):
        try:
            sdl2.SDL_HapticStopAll(self.h)
            for eid, _ in self.effects.values():
                sdl2.SDL_HapticDestroyEffect(self.h, eid)
        finally:
            sdl2.SDL_HapticClose(self.h)
