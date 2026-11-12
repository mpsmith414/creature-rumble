# Creature Rumble

A family TV game. Everyone makes a creature on their phone, and the TV turns them into upright cartoon fighters that make
big entrances and flop around a padded ring until the last one standing is crowned champion. An announcer calls the
fight out loud, and every line is also shown on screen.

## Setup

You need Node 24 or newer.

```sh
npm install
```

Create a `.env` file (see `.env.example`) with your Anthropic API key. It is what lets the designer turn a phone's drawing
or description into a fighter:

```
ANTHROPIC_API_KEY=your-key-here
```

## Running it

- `npm run dev` starts the game for development: the TV page at `http://localhost:5200/` with hot reload, plus the API.
- `npm run home` builds the game and serves it, with the API, on port 8797. Use it for an evening in the living room.
  Open `http://localhost:8797/` in the browser on the PC that is plugged into the TV. The address phones should use is
  printed when it starts.

Run one or the other, not both: they share the API port.

## Joining with phones

Phones need to be on the same Wi-Fi as the PC. Open the phone page printed by `npm run home`, or scan the QR code the TV
shows, or open the page and type the short join code. Pick a name, make a creature, and send it to the TV.

On the phone, hold the **Crown** button for two seconds to crown the champion (a quick tap is not enough, so nobody
crowns by accident).

## TV controls

Use a TV remote, a keyboard or a game controller.

- **Enter** or the remote's **Menu** key opens the menu (Start on a controller). **Back** or **Esc** closes it.
- The menu has: **Crown the champion!** and **Again!** (they appear when they can be used), **Fighters** (send a past
  fighter back in), **Show join code**, **Sound** (quieter, louder, on/off), **Clear the ring** and **Back to the fight**.
- The arrow keys (or the d-pad) move around the menu, and Enter presses a button.

## Tests

```sh
npm test            # unit tests
npm run balance     # plays many fights to check that no kind of fighter dominates
npm run build       # type-check and production build
```

## Credits

See [CREDITS.md](CREDITS.md).
