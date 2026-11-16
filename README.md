# DriveReady — driving school simulator

A 3D driving-school simulator that runs in the browser. Learn the controls on a
training ground, practise parking, then take a city exam with AI traffic,
traffic lights and an instructor who scores every mistake.

## Run it

Open `index.html` in a browser — no install or build step. (Three.js is bundled
in `vendor/three.min.js`.)

## Lessons

| Lesson | What you practise |
| --- | --- |
| 1 · First steps | Seatbelt, engine, gear selector, cone slalom, stopping in a box |
| 2 · Parking | Parking in a free bay between parked cars |
| 3 · City exam | A set route through traffic with lights, lane discipline and turn signals |
| Free drive | The whole city, no route — mistakes are still called out |

You start with 100 points. Finish with 70 or more to pass; dropping to 40 fails
the lesson on the spot.

| Mistake | Penalty |
| --- | --- |
| Running a red light | 25 |
| Collision (vehicle, parked car, building) | 20 |
| Driving on the wrong side / without a seatbelt | 10 |
| Speeding (50 km/h city, 20 km/h training ground) | 5 |
| Leaving the road, knocking a cone, turning without a signal | 5 |

The menu lets you choose whether traffic keeps left or right.

## Controls

| Key | Action |
| --- | --- |
| `W` / `↑`, `S` / `↓` | Accelerate, brake |
| `A` `D` / `←` `→` | Steer |
| `B`, `I` | Seatbelt, engine |
| `Z` / `X` (or `1`–`4`) | Gear down / up: P R N D |
| `Q` / `E` | Left / right turn signal |
| `Space` | Handbrake |
| `C` | Camera: chase, cockpit, top-down |
| `R`, `Esc`, `M` | Restart lesson, pause, mute |

On touch screens, on-screen pedals and steering buttons appear and the
dashboard buttons are tappable.

## Files

- `index.html` — page, HUD and menus
- `main.js` — world, car physics, traffic AI, rules and lessons
- `vendor/three.min.js` — Three.js r170 (MIT licence, see `vendor/THREE-LICENSE`)
