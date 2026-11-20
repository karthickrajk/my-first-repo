# DriveReady — driving school simulator

A 3D LMV driving-school simulator that runs in the browser. Vertex-style
modules cover RTO tracks (H / 8 / parking / ramp), city traffic, rain / night /
fog, village roads, mountain tunnel and an NHAI highway — with an instructor
screen that scores every mistake.

## Run it

Open `index.html` in a browser — no install or build step. (Three.js is bundled
in `vendor/three.min.js`.)

## Play online

Every push to `master` publishes the game for free on GitHub Pages:
https://karthickrajk.github.io/my-first-repo/

## Force feedback (Windows app)

In `DriveReady.exe`, force-feedback wheels (Logitech G29/G920/G923,
Thrustmaster and other DirectInput wheels) get real steering feel:

- heavy, resistant steering when parked or parking
- the wheel pulls back to straight, more strongly the faster you drive
- lighter steering in the rain
- a rumble when you leave the road, and a jolt on collisions, cones and stalls

Open **Steering wheel / pedals → Set up** to choose Off / Light / Medium /
Strong, use **Test push** to check it, and **Reverse direction** if the wheel
pushes the wrong way. Turn off the wheel's own centring spring in Logitech G
HUB or the Thrustmaster Control Panel so it doesn't fight the game. Browsers
cannot drive a wheel's motor, so this works only in the Windows app; it uses
SDL2 (`pysdl2`) through `ffb.py`.

## Three monitors

Choose **Screens: Three** on the menu, then stretch the game window across
three side-by-side monitors of the same size (or use NVIDIA Surround / AMD
Eyefinity, which present them as one wide screen). The left, front and right
views are angled so they join up, and the dashboard stays on the middle screen.
Press `F11` for full screen.

## Instructor screen

Click **Open instructor screen** on the menu (allow pop-ups if the browser
asks) and drag the new window to the instructor's monitor or laptop. It shows:

- a live map of the car, traffic, pedestrians and the next target
- speed, limit, gear, score, lesson time, belt/engine, and the pedals
- a timed log of every step and mistake

and lets the instructor start, restart, pause or end lessons, choose the
gearbox, switch day/dusk/night and clear/rain/fog (rain lowers grip and
braking), set the amount of traffic, turn pedestrians on or off, send
messages that appear on the student's screen, and call an **emergency stop**
that times how quickly the student stops (over 4 seconds costs 10 points).

## Steering wheel, pedals and controllers

USB steering wheels with pedals (Logitech G29/G920/G923, Thrustmaster, Fanatec
and others) and game controllers work through the browser's Gamepad API.

1. Plug the device in and open the game in **Chrome or Edge**.
2. Press any button on the device so the browser notices it.
3. On the menu, click **Steering wheel / pedals → Set up**.
4. For each control click **Set**, then move it: turn the wheel left as far
   as you want full lock, press each pedal all the way, or press the button.
   Steering, accelerator and brake are required; clutch, paddles, H-shifter
   gears, indicators, horn, parking brake, engine, seatbelt, camera and pause
   are optional. The mapping is saved for that device.

Pedals are analog, so half throttle and half braking work. With a clutch pedal
the clutch is exactly where your foot is, and an H-shifter holds the gear while
the lever is in the slot (neutral when it is out). Xbox and PlayStation
controllers work without setup: left stick steers, the triggers are gas and
brake, and the shoulder buttons change gear. The keyboard keeps working too.

## Language

The menu switches between English and Tamil (தமிழ்). All menus, instructor
messages and penalties are translated; the choice is remembered.

## Windows app (.exe)

`app.py` is a small Python launcher that opens the game in its own window.

- **Download:** every push builds `DriveReady.exe` on GitHub — open the repo's
  *Actions* tab, pick the latest "Build Windows exe" run and download the
  `DriveReady-windows` artifact.
- **Build it yourself (Windows, Python 3.9+):** double-click `build_exe.bat`;
  the result is `dist\DriveReady.exe`.
- **Run without building:** `pip install pywebview` then `python app.py`.

## Lessons (Vertex-style LMV modules)

Grouped like commercial LMV simulator curricula (RTO tracks, city/traffic, weather, terrains):

| Lesson | What you practise |
| --- | --- |
| 1 · Pre-drive checks | Seatbelt, mirrors, indicators, horn, engine — cockpit checks before moving |
| 2 · Hand & foot controls | Steering, pedals, gears, cone slalom, controlled stop |
| 3 · Road signs | Speed limits, STOP and pedestrian signs on a short route |
| 4 · Parking | Free bay between parked cars (RTO parking track) |
| 5 · "8" track | Figure of eight between cones (RTO) |
| 6 · "H" track | Forward through the H, then reverse back (RTO) |
| 7 · Ramp / hill start | Stop on a slope, pull away without rolling back (RTO ramp) |
| 8 · Traffic scenario | Dense urban traffic — buses, autos, two-wheelers |
| 9 · City road scenario | Lights, STOP signs, 30 zones, zebra crossings, signals |
| 10 · AI traffic lights | Junction timing — stop on red, go on green |
| 11 · Realistic rain | Wet grip, longer braking |
| 12 · Night scenario | Low-light city driving with headlights |
| 13 · Realistic fog | Short sight distance, bigger gaps |
| 14 · All time · all weather | Free practice; switch conditions from the instructor screen |
| 15 · Village scenario | Rural roads, temple landmark, 30 km/h lanes |
| 16 · Mountain & valley | Climbing bends with elevation |
| 17 · Mountain tunnel | Dark tunnel drive with auto headlights |
| 18 · NHAI highway | Multi-lane highway, 80 km/h, lane discipline |
| Free drive | City, village, highway and mountain — mistakes still called out |

You start with 100 points. Finish with 70 or more to pass; dropping to 40 fails
the lesson on the spot.

| Mistake | Penalty |
| --- | --- |
| Hitting a pedestrian | 60 |
| Running a red light | 25 |
| Collision (vehicle, parked car, building) | 20 |
| Not stopping at a STOP sign, not giving way at a zebra crossing | 15 |
| Driving on the wrong side / without a seatbelt, rolling back on the hill | 10 |
| Speeding (50 km/h city, 30 km/h zones, 20 km/h training ground) | 5 |
| Leaving the road, knocking a cone, turning without a signal, stalling | 5 |

Traffic keeps left by default (as in India); the menu can switch it to keep right.

The menu also switches between an **automatic** and a **manual gearbox**. In
manual you hold the clutch (`Shift`) to change gear, need gas to move off, and
stall if you stop in gear without the clutch or let the revs drop too low.

A rear-view mirror and two wing mirrors are shown in the chase and cockpit
cameras (`V` hides them). The horn (`H`) makes pedestrians waiting at a nearby
crossing hold back.

Traffic is a mix of cars, two-wheelers (riding nearer the kerb), yellow autos
and buses, each with its own size, speed and acceleration. Hitting a
two-wheeler is recorded separately.

Pedestrians walk the pavements and cross at the zebra crossings. Road signs show
the speed limit wherever it changes, mark the two all-way STOP junctions and warn
of each crossing.

## Controls

| Key | Action |
| --- | --- |
| `W` / `↑`, `S` / `↓` | Accelerate, brake |
| `A` `D` / `←` `→` | Steer |
| `B`, `I` | Seatbelt, engine |
| `Z` / `X` | Gear down / up (automatic: P R N D, manual: R N 1–5) |
| `Shift` | Clutch (manual gearbox) |
| `1`–`5`, `N` | Select a gear directly |
| `Q` / `E` | Left / right turn signal |
| `Space` | Parking brake on / off |
| `C` | Camera: chase, cockpit, top-down |
| `H`, `V` | Horn, mirrors on / off |
| `R`, `Esc`, `M` | Restart lesson, pause, mute |

On touch screens, on-screen pedals and steering buttons appear and the
dashboard buttons are tappable.

## Files

- `index.html` — page, HUD and menus
- `main.js` — world, car physics, traffic AI, rules and lessons
- `instructor.html` — the instructor screen
- `lang-ta.js` — Tamil translations
- `app.py`, `ffb.py` — Windows app launcher and force feedback
- `vendor/three.min.js` — Three.js r170 (MIT licence, see `vendor/THREE-LICENSE`)
