# Flow Stacks Extension Checklist

| Feature | Status | Test Command |
| :--- | :--- | :--- |
| Basic extension skeleton + prefs window stub (safe to enable/disable) | Implemented & Tested | `gnome-extensions enable dock-stacks@dragos` |
| Settings schema with: grid-mode (auto/always/never), fan-threshold (default 12, range 8-20) | Implemented & Tested | `gsettings list-keys org.gnome.shell.extensions.dock-stacks` |
| Prefs UI (Adwaita style) with toggles for grid-mode and threshold slider | Implemented & Tested | `gnome-extensions prefs dock-stacks@dragos` |
| Ability to drag ANY folder from Nautilus (or desktop) onto the dock → it becomes a new permanent “stack” icon | In Progress | N/A |
| Dock integration: injects stack support into existing dash cleanly | Implemented & Tested | N/A |
| macOS-style fan animation for clicking a stack icon (≤ threshold) | Not Started | N/A |
| Stack icon visually matches Dash styling (size, centering, hover glow) | In Progress (Hover glow missing) | N/A |
| Fan items have GNOME-style hover labels (and StackIcon itself has a label) | Implemented & Tested (StackIcon label) | N/A |
| Grid popup for > threshold (or grid-mode=always) with live filter | Not Started | N/A |
| Drag files/folders onto stack icon → animation & moves file | Not Started | N/A |
| Drag items OUT of fan/grid view → elastic detach, list updates live | Not Started | N/A |
| All animations are buttery smooth (Clutter/GSK transitions) | Not Started | N/A |
| Live directory monitoring (Gio.FileMonitor) | Not Started | N/A |
| Type-to-search in both fan and grid views | Not Started | N/A |
| Full error handling and crash-proof disable | Not Started | `gnome-extensions disable dock-stacks@dragos` |
| Extension works on latest non-beta GNOME 49 (and early GNOME 50) | Not Started | N/A |
