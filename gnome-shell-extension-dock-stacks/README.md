# Dock Stacks

macOS-style stacks for the GNOME Dash. Pin any folder to your dock and browse its contents in a fan or grid overlay — no file manager needed.

![Dock Stacks in action](screenshot.png)

## Features

- **Fan and grid layouts** — small folders fan out elegantly; larger ones switch to a scrollable grid
- **Drag and drop** — drag files out of stacks onto your desktop or other apps
- **Live previews** — image and video thumbnails render inline
- **Configurable** — choose folders to pin, set fan/grid thresholds, and more via the preferences panel
- **Lightweight** — no background processes, purely a GNOME Shell extension

## Requirements

- GNOME Shell 49 or 50
- Wayland or X11

## Installation

### From extensions.gnome.org

Search for **Dock Stacks** on [extensions.gnome.org](https://extensions.gnome.org/) and click Install.

### Manual

```bash
git clone https://github.com/dragosol/dock-stacks.git
cd dock-stacks
cp -r . ~/.local/share/gnome-shell/extensions/dock-stacks@dragos/
glib-compile-schemas schemas/
```

Then restart GNOME Shell (log out and back in on Wayland, or `Alt+F2 → r` on X11) and enable the extension:

```bash
gnome-extensions enable dock-stacks@dragos
```

## Configuration

Open the extension preferences via GNOME Extensions app or:

```bash
gnome-extensions prefs dock-stacks@dragos
```

| Setting | Description | Default |
|---------|-------------|---------|
| Configured Folders | Folder paths pinned to the dock | `[]` |
| Grid Mode | `auto`, `always`, or `never` | `auto` |
| Fan Threshold | Max items before switching to grid | `12` |

## License

GPL-2.0-or-later
