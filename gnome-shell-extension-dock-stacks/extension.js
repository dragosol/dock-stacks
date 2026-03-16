import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

// ─── Drag & Drop Helpers ────────────────────────────────────────────────────

/**
 * Query Nautilus's current directory for a given MetaWindow via the
 * org.freedesktop.FileManager1 D-Bus interface.
 * Returns a string path (e.g. '/home/user/Downloads') or null.
 */
function _getNautilusDirectoryForWindow(metaWindow) {
    // Try OpenWindowsWithLocations first (maps window object paths → location URIs)
    try {
        const result = Gio.DBus.session.call_sync(
            'org.freedesktop.FileManager1',
            '/org/freedesktop/FileManager1',
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', ['org.freedesktop.FileManager1', 'OpenWindowsWithLocations']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            1000,
            null
        );

        if (result) {
            const variant = result.deep_unpack()[0];
            const windowsMap = variant.deep_unpack(); // Dict: {string objectPath: [string uri, ...]}

            // Just grab the first window's first location
            for (const [_objPath, uris] of Object.entries(windowsMap)) {
                if (uris && uris.length > 0) {
                    const gfile = Gio.File.new_for_uri(uris[0]);
                    const path = gfile.get_path();
                    if (path) {
                        console.log(`[Dock Stacks] Nautilus dir from OpenWindowsWithLocations: ${path}`);
                        return path;
                    }
                }
            }
        }
    } catch (e) {
        console.log(`[Dock Stacks] OpenWindowsWithLocations failed: ${e}`);
    }

    // Fallback to OpenLocations (flat array of all open URIs)
    try {
        const result = Gio.DBus.session.call_sync(
            'org.freedesktop.FileManager1',
            '/org/freedesktop/FileManager1',
            'org.freedesktop.DBus.Properties',
            'Get',
            new GLib.Variant('(ss)', ['org.freedesktop.FileManager1', 'OpenLocations']),
            new GLib.VariantType('(v)'),
            Gio.DBusCallFlags.NONE,
            1000,
            null
        );

        if (result) {
            const variant = result.deep_unpack()[0];
            const locations = variant.deep_unpack();

            if (locations && locations.length > 0) {
                const gfile = Gio.File.new_for_uri(locations[0]);
                const path = gfile.get_path();
                if (path) {
                    console.log(`[Dock Stacks] Nautilus dir from OpenLocations: ${path}`);
                    return path;
                }
            }
        }
    } catch (e) {
        console.log(`[Dock Stacks] OpenLocations failed: ${e}`);
    }

    return null;
}

/**
 * Perform the file drop action based on where the cursor ended up.
 * @param {object} data - The item data object with .uri, .name, etc.
 * @param {number} dropX - Global X coordinate of the drop
 * @param {number} dropY - Global Y coordinate of the drop
 */
function _handleFileDrop(data, dropX, dropY, modifiers) {
    if (!data.uri) return;

    // Hold Ctrl to copy instead of move (macOS-style: move is default)
    const isCopy = !!(modifiers & Clutter.ModifierType.CONTROL_MASK);

    // Get the file we're dragging
    const sourceFile = Gio.File.new_for_uri(data.uri);
    if (!sourceFile.query_exists(null)) {
        console.error(`[Dock Stacks] Source file does not exist: ${data.uri}`);
        return;
    }

    // Check what's under the cursor — iterate in reverse so the TOPMOST window wins
    const windowActors = global.get_window_actors();
    let targetWindow = null;

    for (let i = windowActors.length - 1; i >= 0; i--) {
        const meta = windowActors[i].get_meta_window();
        if (!meta || meta.is_hidden() || meta.minimized) continue;

        const rect = meta.get_frame_rect();
        if (dropX >= rect.x && dropX <= rect.x + rect.width &&
            dropY >= rect.y && dropY <= rect.y + rect.height) {
            targetWindow = meta;
            break;
        }
    }

    if (!targetWindow) {
        // No window under cursor → drop to Desktop
        const desktopPath = GLib.get_home_dir() + '/Desktop';
        const desktopDir = Gio.File.new_for_path(desktopPath);
        if (!desktopDir.query_exists(null)) {
            try {
                desktopDir.make_directory_with_parents(null);
            } catch (e) {
                console.error(`[Dock Stacks] Failed to create Desktop dir: ${e}`);
                return;
            }
        }
        const destFile = desktopDir.get_child(sourceFile.get_basename());
        try {
            if (isCopy) {
                sourceFile.copy(destFile, Gio.FileCopyFlags.NONE, null, null);
                console.log(`[Dock Stacks] Copied ${data.name} to ~/Desktop/`);
            } else {
                sourceFile.move(destFile, Gio.FileCopyFlags.NONE, null, null);
                console.log(`[Dock Stacks] Moved ${data.name} to ~/Desktop/`);
            }
        } catch (e) {
            console.error(`[Dock Stacks] Failed to copy to Desktop: ${e}`);
        }
        return;
    }

    // Identify the target window using ALL available methods (Wayland often lacks WM_CLASS)
    const wmClass = (targetWindow.get_wm_class() || '').toLowerCase();
    let gtkAppId = '';
    let sandboxId = '';
    try { gtkAppId = (targetWindow.get_gtk_application_id() || '').toLowerCase(); } catch (e) { /* n/a */ }
    try { sandboxId = (targetWindow.get_sandboxed_app_id() || '').toLowerCase(); } catch (e) { /* n/a */ }

    console.log(`[Dock Stacks] Drop target — WM_CLASS: "${wmClass}", GTK_APP_ID: "${gtkAppId}", SANDBOX_ID: "${sandboxId}", title: "${targetWindow.get_title()}"`);

    const isNautilus = wmClass.includes('nautilus') || wmClass.includes('files') ||
        gtkAppId.includes('nautilus') || gtkAppId.includes('org.gnome.nautilus') ||
        sandboxId.includes('nautilus');

    if (isNautilus) {
        const nautilusDir = _getNautilusDirectoryForWindow(targetWindow);
        if (nautilusDir) {
            const destDir = Gio.File.new_for_path(nautilusDir);
            const destFile = destDir.get_child(sourceFile.get_basename());
            try {
                if (isCopy) {
                    sourceFile.copy(destFile, Gio.FileCopyFlags.NONE, null, null);
                    console.log(`[Dock Stacks] Copied ${data.name} to ${nautilusDir}`);
                } else {
                    sourceFile.move(destFile, Gio.FileCopyFlags.NONE, null, null);
                    console.log(`[Dock Stacks] Moved ${data.name} to ${nautilusDir}`);
                }
            } catch (e) {
                console.error(`[Dock Stacks] Failed to move to Nautilus dir: ${e}`);
            }
            return;
        }
        console.error(`[Dock Stacks] Could not determine Nautilus directory, cancelling drop.`);
        return;
    }

    // Any other app → open the file with its default handler.
    // This is the closest we can get to native DnD from the shell compositor:
    // it opens the file as if you had double-clicked it / dragged it onto the app icon.
    // True Wayland cross-process DnD (like uploading to a browser drop zone) is not
    // technically possible from within the GNOME Shell compositor process.
    try {
        Gio.AppInfo.launch_default_for_uri(data.uri, null);
        console.log(`[Dock Stacks] Opened ${data.name} with default handler`);
    } catch (e) {
        console.error(`[Dock Stacks] Failed to open ${data.name}: ${e}`);
    }
}

/**
 * Make an itemContainer manually draggable using raw captured events.
 * St.Button internally consumes button-press-event, blocking Clutter.DragAction.
 * So we track press→motion→release via global.stage captured-event instead.
 *
 * @param {St.Button} itemContainer - The container to make draggable
 * @param {object} data - The item data (.uri, .name, .icon, etc.)
 * @param {StackPopup|GridPopup} popup - The parent popup (to close on successful drop)
 */
function _setupDragAction(itemContainer, data, popup) {
    // Don't make action items (like "Open in Files") draggable
    if (data.isAction) return;

    let pressX = 0, pressY = 0;
    let isPressed = false;
    let isDragging = false;
    let dragClone = null;
    let capturedEventId = null;

    const DRAG_THRESHOLD = 12; // px before we consider it a drag

    // Listen for button press on the item
    itemContainer.connect('button-press-event', (actor, event) => {
        if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE; // Left click only
        [pressX, pressY] = event.get_coords();
        isPressed = true;
        isDragging = false;

        // Attach a global captured-event listener to track motion/release
        if (capturedEventId) {
            global.stage.disconnect(capturedEventId);
            capturedEventId = null;
        }

        capturedEventId = global.stage.connect('captured-event', (stage, ev) => {
            const type = ev.type();

            if (type === Clutter.EventType.MOTION) {
                if (!isPressed) return Clutter.EVENT_PROPAGATE;

                const [mx, my] = ev.get_coords();
                const dx = mx - pressX;
                const dy = my - pressY;

                if (!isDragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
                    // Start the drag!
                    isDragging = true;
                    popup._isDragging = true;

                    // Disable the fan's event blocker so button-release reaches underlying windows
                    if (popup._eventBlocker) popup._eventBlocker.reactive = false;

                    dragClone = new Clutter.Clone({
                        source: itemContainer,
                        opacity: 180,
                    });
                    // Position clone at item's current screen position
                    const [ix, iy] = itemContainer.get_transformed_position();
                    dragClone.set_position(ix, iy);
                    Main.uiGroup.add_child(dragClone);

                    // Dim the original
                    itemContainer.set_opacity(80);
                }

                if (isDragging && dragClone) {
                    // Move the clone to follow the cursor
                    const [cloneW, cloneH] = [dragClone.width, dragClone.height];
                    dragClone.set_position(mx - cloneW / 2, my - cloneH / 2);
                    return Clutter.EVENT_STOP; // Consume motion during drag
                }

                return Clutter.EVENT_PROPAGATE;
            }

            if (type === Clutter.EventType.BUTTON_RELEASE) {
                if (!isPressed) return Clutter.EVENT_PROPAGATE;

                const wasDragging = isDragging;
                const [releaseX, releaseY] = ev.get_coords();
                const modifiers = ev.get_state();

                // Cleanup
                isPressed = false;
                isDragging = false;
                popup._isDragging = false;

                // Re-enable the event blocker
                if (popup._eventBlocker) popup._eventBlocker.reactive = true;

                if (capturedEventId) {
                    global.stage.disconnect(capturedEventId);
                    capturedEventId = null;
                }

                if (dragClone) {
                    dragClone.destroy();
                    dragClone = null;
                }

                itemContainer.set_opacity(255);

                if (wasDragging) {
                    // If released close to where the drag started, cancel the drag
                    const snapBackDist = Math.sqrt(
                        (releaseX - pressX) ** 2 + (releaseY - pressY) ** 2
                    );
                    if (snapBackDist < 30) {
                        // Snap-back cancel — user dragged back to origin
                        return Clutter.EVENT_STOP;
                    }

                    // Perform the drop
                    _handleFileDrop(data, releaseX, releaseY, modifiers);
                    popup.close();
                    return Clutter.EVENT_STOP; // Consume the release so it doesn't trigger a click
                }

                return Clutter.EVENT_PROPAGATE; // Let normal click through
            }

            return Clutter.EVENT_PROPAGATE;
        });

        return Clutter.EVENT_PROPAGATE; // Let St.Button handle its normal pressed state
    });

    // Safety: disconnect on destroy
    itemContainer.connect('destroy', () => {
        if (capturedEventId) {
            global.stage.disconnect(capturedEventId);
            capturedEventId = null;
        }
        if (dragClone) {
            dragClone.destroy();
            dragClone = null;
        }
    });
}


class StackPopup extends St.Widget {
    static {
        GObject.registerClass(this);
    }

    constructor(sourceIcon) {
        super({
            reactive: true,
            can_focus: true,
            layout_manager: new Clutter.FixedLayout(),
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height
        });

        this.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL
        }));

        this.sourceIcon = sourceIcon;
        this._items = [];
        this._isOpen = false;

        // An invisible shield catching clicks to close the fan
        this._eventBlocker = new St.Widget({
            reactive: true,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height
        });

        this._eventBlocker.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL
        }));

        this._eventBlocker.connect('button-press-event', () => {
            if (this._isOpen) this.close();
            return Clutter.EVENT_STOP;
        });

        // The container holding the fanned-out icons
        this._fanContainer = new St.Widget({
            layout_manager: new Clutter.FixedLayout(),
            reactive: false,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height
        });

        this._fanContainer.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL
        }));

        this.add_child(this._eventBlocker);
        this.add_child(this._fanContainer);
    }

    open(itemsData) {
        if (this._isOpen) return;
        this._isOpen = true;
        this._items = itemsData;
        this._sushiWasOpen = false;

        // Add to window_group so standard applications (like Sushi previews) can layer on top of it
        // We do not force it above null (topmost) so Sushi can effortlessly render above the fan
        global.window_group.add_child(this);

        // Dynamically monitor Wayland window focus and restacks to enforce exact Z-Ordering!
        this._syncZOrder = () => {
            if (!this._isOpen) return;
            let sushiActor = null;
            let topAppActor = null;

            // `global.get_window_actors()` returns actors reliably ordered from bottom to top
            global.get_window_actors().forEach(actor => {
                if (actor.get_parent() !== global.window_group) return;
                const win = actor.meta_window;
                if (!win) return;

                topAppActor = actor; // The last one evaluated will be the topmost app inherently

                const wmClass = win.get_wm_class() ? win.get_wm_class().toLowerCase() : '';
                const title = win.get_title() ? win.get_title().toLowerCase() : '';

                if (wmClass.includes('sushi') || wmClass.includes('previewer') || title.includes('sushi')) {
                    sushiActor = actor;
                }
            });

            // Immediately sink beneath Sushi if it's open
            if (sushiActor) {
                global.window_group.set_child_below_sibling(this, sushiActor);
                this._sushiWasOpen = true;
            } else {
                if (topAppActor) {
                    global.window_group.set_child_above_sibling(this, topAppActor);
                }
                // If Sushi just closed, grab focus back!
                if (this._sushiWasOpen) {
                    this._sushiWasOpen = false;
                    this.grab_key_focus();
                }
            }
        };

        this._restackedId = global.display.connect('restacked', this._syncZOrder);

        // Force an immediate evaluation on fan open so we sit above text editors instantly
        this._syncZOrder();

        this.grab_key_focus();

        const [sourceX, sourceY] = this.sourceIcon.button.get_transformed_position();
        const [sourceW, sourceH] = this.sourceIcon.button.get_transformed_size();

        const originX = sourceX + (sourceW / 2);
        const originY = sourceY;

        let lastOriginX = originX;
        let lastOriginY = originY;

        this._trackingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (!this._isOpen) return GLib.SOURCE_REMOVE;
            const [newX, newY] = this.sourceIcon.button.get_transformed_position();
            const newOriginX = newX + (sourceW / 2);
            if (newOriginX !== lastOriginX || newY !== lastOriginY) {
                this._fanContainer.translation_x = newOriginX - originX;
                this._fanContainer.translation_y = newY - originY;
                lastOriginX = newOriginX;
                lastOriginY = newY;
            }
            return GLib.SOURCE_CONTINUE;
        });

        let index = 0;

        // The exact array order passed in matches the physical stacking from bottom to top:
        // Index 0 -> physically lowest (nearest to Dock). Index N -> physically highest.
        const displayItems = itemsData;

        // Curve outwards from the nearest screen edge
        const curveDirection = originX < (global.stage.width / 2) ? 1 : -1;

        for (const data of displayItems) {
            let iconWidget;

            if (data.isImage && data.imageUri) {
                iconWidget = new St.Widget({
                    style: `background-image: url("${data.imageUri}"); background-size: cover; background-position: center; border-radius: 4px; border: 3px solid #ffffff; width: 48px; height: 48px; margin: 0;`
                });
            } else {
                iconWidget = new St.Icon({
                    gicon: data.icon,
                    icon_size: 48,
                    style_class: 'stack-item-icon'
                });

                if (data.isAction) {
                    iconWidget.set_style('');
                } else {
                    iconWidget.set_style('border-radius: 4px;');
                }
            }

            const labelWidget = new St.Label({
                text: data.name,
                style_class: 'dash-label',
                y_align: Clutter.ActorAlign.CENTER,
                style: 'margin-right: 12px;' // Spacing from the icon
            });

            const itemBox = new St.BoxLayout({
                vertical: false,
                y_align: Clutter.ActorAlign.CENTER
            });
            itemBox.add_child(labelWidget);
            itemBox.add_child(iconWidget);

            // Container for icon + tooltip if needed
            const itemContainer = new St.Button({
                reactive: true,
                can_focus: true,
                track_hover: true,
                child: itemBox,
                style_class: 'app-well-app', // ensures it has padding/size and hover effects
                height: 64
            });

            itemContainer._isFanOpened = false;

            // Enable drag-and-drop for this fan item
            _setupDragAction(itemContainer, data, this);

            // Handle hover zoom
            itemContainer.connect('notify::hover', () => {
                if (!itemContainer._isFanOpened) return;

                const targetScale = itemContainer.hover ? 1.05 : 1.0;
                itemContainer.ease({
                    scale_x: targetScale,
                    scale_y: targetScale,
                    duration: 120,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
            });

            // Handle file launches
            itemContainer.connect('clicked', () => {
                try {
                    if (data.isAction && data.folderPath) {
                        Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(data.folderPath).get_uri(), null);
                    } else if (data.uri) {
                        Gio.AppInfo.launch_default_for_uri(data.uri, null);
                    }
                } catch (e) {
                    console.error(`[Dock Stacks] Failed to open ${data.name}:`, e);
                }
                this.close();
            });

            // Calculate destination properties (Arc and Tilt)
            const gap = 4;

            // MacOS fan always arcs to the right, forming a geometric curve
            // Math.pow gives the parabolic curve
            const xShift = Math.pow(index, 1.8) * 2.5;

            // Icons tilt clockwise
            const tiltAngle = index * 2.5;
            const destY = originY - ((index + 1) * (64 + gap));

            const i = index; // capture for closure
            this._fanContainer.add_child(itemContainer);

            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (!itemContainer) return GLib.SOURCE_REMOVE;

                const [minW, natW] = itemContainer.get_preferred_width(-1);

                // Set pivot point EXACTLY at the center of the icon
                // The icon is roughly 64px wide and sits at the right edge
                const pivotX = 1.0 - (32 / natW);
                itemContainer.set_pivot_point(pivotX, 0.5);

                // Forces Clutter to render the allocated actor to an offscreen texture for flawless anti-aliased rotation
                itemContainer.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);

                // Align so the pivot point tracks the originX + curve
                const destX = originX + xShift - natW + 32;

                // Start from the exact dock icon center
                const startX = originX - natW + 32;
                const startY = originY + (sourceH / 2) - 32;

                itemContainer.set_position(startX, startY);
                itemContainer.set_scale(0.1, 0.1);
                itemContainer.rotation_angle_z = tiltAngle;
                itemContainer.set_opacity(0); // Initially hidden before ease

                // Animate to final state
                itemContainer.ease({
                    x: destX,
                    y: destY,
                    scale_x: 1,
                    scale_y: 1,
                    opacity: 255,
                    duration: 140,
                    delay: i * 11, // Staggered
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        itemContainer._isFanOpened = true;
                    }
                });

                return GLib.SOURCE_REMOVE;
            });

            index++;
        }

        // Connect localized checking for GNOME Sushi previews using global captured events
        // This intercepts the Spacebar BEFORE Wayland routes it to the focused text app,
        // allowing the user to repeatedly tap Spacebar without moving their mouse to regain focus!
        this._keyPressId = global.stage.connect('captured-event', (actor, event) => {
            if (event.type() !== Clutter.EventType.KEY_PRESS) return Clutter.EVENT_PROPAGATE;

            // If Sushi is actively rendering above us, surrender keyboard intercepts to it!
            if (this._sushiWasOpen) return Clutter.EVENT_PROPAGATE;

            if (event.get_key_symbol() === Clutter.KEY_space) {
                const children = this._fanContainer.get_children();
                const [mx, my] = global.get_pointer();

                for (let i = 0; i < children.length; i++) {
                    const child = children[i];

                    const [_, x, y] = child.get_transformed_position();
                    const [__, w, h] = child.get_transformed_size();
                    const isHovered = child.hover || (mx >= x && mx <= x + w && my >= y && my <= y + h);

                    if (isHovered) {
                        const data = displayItems[i];
                        if (!data.isAction && data.uri) {
                            try {
                                // Direct DBus Native invocation ensures Wayland compliance in GNOME
                                Gio.DBus.session.call('org.gnome.NautilusPreviewer',
                                    '/org/gnome/NautilusPreviewer',
                                    'org.gnome.NautilusPreviewer',
                                    'ShowFile',
                                    new GLib.Variant('(sib)', [data.uri, 0, false]),
                                    null,
                                    Gio.DBusCallFlags.NONE,
                                    -1,
                                    null,
                                    (connection, res) => {
                                        try { connection.call_finish(res); } catch (e) { }
                                    });
                            } catch (e) {
                                console.error('[Dock Stacks] Sushi DBus spawn error:', e);
                            }
                        }
                        return Clutter.EVENT_STOP;
                    }
                }
                return Clutter.EVENT_PROPAGATE;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    close() {
        if (!this._isOpen) return;
        this._isOpen = false;

        this.sourceIcon.emit('menu-state-changed', false);
        if (this.sourceIcon && this.sourceIcon._setIntellihide) {
            this.sourceIcon._setIntellihide(false);
        }

        if (this._allocationId) {
            this.sourceIcon.button.disconnect(this._allocationId);
            this._allocationId = null;
        }

        if (this._restackedId) {
            global.display.disconnect(this._restackedId);
            this._restackedId = null;
        }

        if (this._keyPressId) {
            global.stage.disconnect(this._keyPressId);
            this._keyPressId = null;
        }

        const [sourceX, sourceY] = this.sourceIcon.button.get_transformed_position();
        const originY = sourceY;
        const [sourceW, sourceH] = this.sourceIcon.button.get_transformed_size();
        const originX = sourceX + (sourceW / 2);

        const children = this._fanContainer.get_children();
        for (const child of children) {
            child._isFanOpened = false;
            const [minW, natW] = child.get_preferred_width(-1);
            const startX = originX - natW + 32;
            const startY = originY + (sourceH / 2) - 32;

            child.ease({
                x: startX,
                y: startY,
                scale_x: 0.1,
                scale_y: 0.1,
                opacity: 0,
                duration: 84,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => child.destroy()
            });
        }

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            global.window_group.remove_child(this);
            this.destroy();
            return GLib.SOURCE_REMOVE;
        });
    }
}

class GridPopup extends St.Widget {
    static {
        GObject.registerClass(this);
    }

    constructor(sourceIcon) {
        super({
            reactive: true,
            can_focus: true,
            track_hover: true,
            width: global.stage.width,
            height: global.stage.height
        });

        this.sourceIcon = sourceIcon;
        this._isOpen = false;
        this._items = [];
        this._renderedWidgets = [];
        this._mousePosAtLastType = null;

        // Base container for the rounded popover bubble
        // We use BinLayout so the search entry floating on top of the scrollview!
        this._container = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style: 'background-color: rgba(30, 30, 30, 0.9); border-radius: 16px; border: 1px solid rgba(255,255,255,0.08); width: 480px; height: 600px;',
            opacity: 0 // Start invisible to prevent flash at (0,0) before idle_add positions it
        });

        // Search Entry for Filtering
        this._searchEntry = new St.Entry({
            hint_text: 'Type to filter...',
            x_expand: true,
            style: 'border-radius: 6px; padding: 8px 12px; background-color: rgba(45, 45, 45, 1.0); border: 1px solid rgba(255,255,255,0.05); color: white; box-shadow: 0px 4px 12px rgba(0,0,0,0.25);'
        });

        this._searchWrapper = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.START,
            style: 'margin: 16px 16px 0px 16px;'
        });
        this._searchWrapper.add_child(this._searchEntry);

        this._searchEntry.clutter_text.connect('text-changed', () => {
            this._mousePosAtLastType = global.get_pointer();
            this._filterGrid(this._searchEntry.get_text());
        });

        this._scrollView = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.NEVER, // Remove scrollbar altogether as requested
            enable_mouse_scrolling: true,
            x_expand: true,
            y_expand: true,
            style: 'margin: 0px;' // Let items extend flush to the top/bottom container boundaries
        });

        this._gridContainer = new St.Widget({
            style: 'padding: 8px;'
        });

        // Wrapper to satisfy St.Scrollable interface requirement in GNOME 47
        this._scrollWrapper = new St.BoxLayout({
            vertical: true,
            x_expand: false,
            y_expand: false
        });
        this._scrollWrapper.add_child(this._gridContainer);

        this._scrollView.set_child(this._scrollWrapper);

        // Z-Index ordering: ScrollView underneath, Search Entry floating on top
        this._container.add_child(this._scrollView);
        this._container.add_child(this._searchWrapper);

        this.add_child(this._container);

        // We now handle global dismissal in the captured-event block for absolute reliability
    }

    open(itemsData) {
        if (this._isOpen) return;
        this._isOpen = true;
        this._items = itemsData;
        this._sushiWasOpen = false;

        global.window_group.add_child(this);

        this._syncZOrder = () => {
            if (!this._isOpen) return;
            let sushiActor = null;
            let topAppActor = null;

            global.get_window_actors().forEach(actor => {
                if (actor.get_parent() !== global.window_group) return;
                const win = actor.meta_window;
                if (!win) return;

                topAppActor = actor;

                const wmClass = win.get_wm_class() ? win.get_wm_class().toLowerCase() : '';
                const title = win.get_title() ? win.get_title().toLowerCase() : '';

                if (wmClass.includes('sushi') || wmClass.includes('previewer') || title.includes('sushi')) {
                    sushiActor = actor;
                }
            });

            // Immediately sink beneath Sushi if it's open
            if (sushiActor) {
                global.window_group.set_child_below_sibling(this, sushiActor);
                this._sushiWasOpen = true;
            } else {
                if (topAppActor) {
                    global.window_group.set_child_above_sibling(this, topAppActor);
                }
                if (this._sushiWasOpen) {
                    this._sushiWasOpen = false;
                    this.grab_key_focus();
                    this._searchEntry.grab_key_focus();
                }
            }
        };

        this._restackedId = global.display.connect('restacked', this._syncZOrder);
        this._syncZOrder();

        this.grab_key_focus();
        this._searchEntry.grab_key_focus(); // Auto-focus the search bar!

        const [sourceX, sourceY] = this.sourceIcon.button.get_transformed_position();
        const [sourceW, sourceH] = this.sourceIcon.button.get_transformed_size();

        const originX = sourceX + (sourceW / 2);
        const originY = sourceY;

        let lastOriginX = originX;
        let lastOriginY = originY;

        this._trackingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (!this._isOpen) return GLib.SOURCE_REMOVE;
            const [newX, newY] = this.sourceIcon.button.get_transformed_position();
            const newOriginX = newX + (sourceW / 2);
            if (newOriginX !== lastOriginX || newY !== lastOriginY) {
                this._container.translation_x = newOriginX - originX;
                this._container.translation_y = newY - originY;
                lastOriginX = newOriginX;
                lastOriginY = newY;
            }
            return GLib.SOURCE_CONTINUE;
        });

        // Position the popover slightly above the dock icon
        // We will finalize positioning in an idle loop to get actual size
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._container) return GLib.SOURCE_REMOVE;
            const [, natW] = this._container.get_preferred_width(-1);
            const [, natH] = this._container.get_preferred_height(-1);

            const destX = originX - (natW / 2);
            const destY = originY - natH - 24;

            // Sprout from the absolute center of the dock icon!
            const dockCenterY = originY + (sourceH / 2);
            const startX = originX - (natW / 2);
            const startY = dockCenterY - natH;

            this._container.set_position(startX, startY);
            this._container.set_opacity(0);
            this._container.set_scale(0.1, 0.1); // Sprout from nothing like the Fan
            this._container.set_pivot_point(0.5, 1.0);

            this._container.ease({
                x: destX,
                y: destY,
                scale_x: 1,
                scale_y: 1,
                opacity: 255,
                duration: 200, // Sync with Fan burst duration
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC
            });

            return GLib.SOURCE_REMOVE;
        });

        // Construct grid widgets
        this._items.forEach((data, index) => {
            let iconWidget;

            if (data.isImage && data.imageUri) {
                // We render the background image tightly inside a clean St.Bin.
                const img = new St.Widget({
                    style: `background-image: url("${data.imageUri}"); background-size: cover; background-position: center; border-radius: 4px; border: 3px solid #ffffff; width: 64px; height: 64px; margin: 0;`
                });
                iconWidget = new St.Bin({
                    child: img,
                    style: 'border-radius: 6px; padding: 0;' // Shadow removed as requested
                });
            } else {
                iconWidget = new St.Icon({
                    gicon: data.icon,
                    icon_size: 64,
                    style_class: 'stack-item-icon'
                });

                if (data.isAction) {
                    iconWidget.set_style(''); // Shadow removed
                } else {
                    iconWidget.set_style('border-radius: 4px;'); // Shadow removed
                }
            }

            const nameBox = new St.BoxLayout({ vertical: true });

            // Limit label width and ellipsize for grid uniformity
            const labelWidget = new St.Label({
                text: data.name,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.START,
                style: 'color: white; font-size: 13px; text-align: center; max-width: 80px;'
            });
            labelWidget.clutter_text.ellipsize = window.Pango ? window.Pango.EllipsizeMode.END : 3;
            labelWidget.clutter_text.line_wrap = true;
            labelWidget.clutter_text.line_wrap_mode = window.Pango ? window.Pango.WrapMode.WORD_CHAR : 2;

            const iconBox = new St.BoxLayout({
                vertical: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.START
            });
            iconBox.add_child(iconWidget);
            iconBox.add_child(labelWidget);

            const itemContainer = new St.Button({
                reactive: true,
                can_focus: true,
                track_hover: true,
                child: iconBox,
                style_class: 'app-well-app',
                style: 'border-radius: 12px; padding: 8px; width: 96px; height: 120px;'
            });

            itemContainer._data = data; // Stash for filtering

            // Enable drag-and-drop for this grid item
            _setupDragAction(itemContainer, data, this);
            itemContainer.hoverTargetScale = 1.05;
            itemContainer.set_opacity(0); // Hide initially for cascade animation

            itemContainer.connect('notify::hover', () => {
                const targetScale = itemContainer.hover ? itemContainer.hoverTargetScale : 1.0;
                itemContainer.set_pivot_point(0.5, 0.5);
                itemContainer.ease({
                    scale_x: targetScale,
                    scale_y: targetScale,
                    duration: 120,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });

                // Only steal focus if the mouse is actively moving, not when layout reshuffles under it
                if (itemContainer.hover && !this._mousePosAtLastType) {
                    this.grab_key_focus();
                }
            });

            itemContainer.connect('clicked', () => {
                try {
                    if (data.isAction && data.folderPath) {
                        Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(data.folderPath).get_uri(), null);
                    } else if (data.uri) {
                        Gio.AppInfo.launch_default_for_uri(data.uri, null);
                    }
                } catch (e) {
                    console.error(`[Dock Stacks] Failed to open ${data.name}:`, e);
                }
                this.close();
            });

            this._renderedWidgets.push(itemContainer);
            this._gridContainer.add_child(itemContainer);
        });

        // Map global captured events for Spacebar to trigger GNOME Sushi and outside-clicks to dismiss
        this._keyPressId = global.stage.connect('captured-event', (actor, event) => {
            const type = event.type();

            if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
                const [x, y] = event.get_coords();
                const [cx, cy] = this._container.get_transformed_position();
                const [cw, ch] = this._container.get_transformed_size();

                if (x < cx || x > cx + cw || y < cy || y > cy + ch) {
                    // Don't close if a drag is in progress
                    if (this._isDragging) return Clutter.EVENT_PROPAGATE;

                    // Check if they clicked the source dock icon. If so, let its 'clicked' handler do the toggling!
                    if (this.sourceIcon && this.sourceIcon.button) {
                        const [sx, sy] = this.sourceIcon.button.get_transformed_position();
                        const [sw, sh] = this.sourceIcon.button.get_transformed_size();
                        if (x >= sx && x <= sx + sw && y >= sy && y <= sy + sh) {
                            return Clutter.EVENT_PROPAGATE;
                        }
                    }

                    this.close();
                    return Clutter.EVENT_PROPAGATE; // Do not gobble the click so they can click the dock seamlessly
                }
            }

            if (type === Clutter.EventType.MOTION) {
                if (this._mousePosAtLastType) {
                    const [x, y] = event.get_coords();
                    const dx = x - this._mousePosAtLastType[0];
                    const dy = y - this._mousePosAtLastType[1];
                    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                        this._mousePosAtLastType = null;

                        // If we are currently hovering over an item, grab focus so spacebar works
                        const children = this._gridContainer.get_children();
                        for (let i = 0; i < children.length; i++) {
                            if (children[i].hover) {
                                this.grab_key_focus();
                                break;
                            }
                        }
                    }
                }
                return Clutter.EVENT_PROPAGATE;
            }

            if (type !== Clutter.EventType.KEY_PRESS) return Clutter.EVENT_PROPAGATE;

            // If Sushi is actively rendering above us, surrender keyboard intercepts to it!
            if (this._sushiWasOpen) return Clutter.EVENT_PROPAGATE;

            if (event.get_key_symbol() === Clutter.KEY_space) {
                const children = this._gridContainer.get_children();
                const [mx, my] = global.get_pointer();

                for (let i = 0; i < children.length; i++) {
                    const child = children[i];
                    const [_, x, y] = child.get_transformed_position();
                    const [__, w, h] = child.get_transformed_size();
                    const isHovered = child.hover || (mx >= x && mx <= x + w && my >= y && my <= y + h);

                    // First, evaluate if we can trigger Sushi for the current hover target
                    if (isHovered) {
                        const data = child._data;
                        if (data && !data.isAction && data.uri) {
                            try {
                                Gio.DBus.session.call('org.gnome.NautilusPreviewer',
                                    '/org/gnome/NautilusPreviewer',
                                    'org.gnome.NautilusPreviewer',
                                    'ShowFile',
                                    new GLib.Variant('(sib)', [data.uri, 0, false]),
                                    null,
                                    Gio.DBusCallFlags.NONE,
                                    -1,
                                    null,
                                    (connection, res) => {
                                        try { connection.call_finish(res); } catch (e) { }
                                    });
                            } catch (e) {
                                console.error('[Dock Stacks] Sushi DBus spawn error:', e);
                            }
                        }
                        return Clutter.EVENT_STOP;
                    }
                }
            }

            // Bind Ctrl+F to force focus back into the search bar seamlessly
            const isCtrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
            if (isCtrl && event.get_key_symbol() === Clutter.KEY_f) {
                this._mousePosAtLastType = global.get_pointer();
                this._searchEntry.grab_key_focus();
                return Clutter.EVENT_STOP;
            }

            // Only AFTER verifying we didn't want to Sushi-preview an item, process the search bar text inputs
            if (global.stage.get_key_focus() === this._searchEntry.clutter_text) {
                if (event.get_key_symbol() === Clutter.KEY_Escape) {
                    if (this._searchEntry.get_text() !== '') {
                        this._searchEntry.set_text('');
                        return Clutter.EVENT_STOP;
                    } else {
                        this.close();
                        return Clutter.EVENT_STOP;
                    }
                }
                return Clutter.EVENT_PROPAGATE;
            }

            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        // Initial Layout Pass
        this._filterGrid('');
    }

    _filterGrid(term) {
        const lowerTerm = term.toLowerCase();
        let visibleCount = 0;
        const COLUMNS = 4;
        const PADDING_X = 16;
        const PADDING_Y = 72; // Massive top padding so icons start below the floating search bar
        const PADDING_BOTTOM = 24;
        const ITEM_W = 96;
        const ITEM_H = 120;
        const SPACING = 16;

        this._renderedWidgets.forEach(widget => {
            const show = widget._data.name.toLowerCase().includes(lowerTerm);
            if (show) {
                widget.show();

                const col = visibleCount % COLUMNS;
                const row = Math.floor(visibleCount / COLUMNS);

                const destX = PADDING_X + col * (ITEM_W + SPACING);
                const destY = PADDING_Y + row * (ITEM_H + SPACING);

                widget.ease({
                    x: destX,
                    y: destY,
                    opacity: 255,
                    duration: 150,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });

                visibleCount++;
            } else {
                if (widget.visible && widget.opacity > 0) {
                    widget.ease({
                        opacity: 0,
                        duration: 100,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onComplete: () => widget.hide()
                    });
                } else {
                    widget.hide();
                }
            }
        });

        // Explicitly expand container bounds so the ScrollView can track it seamlessly
        const totalRows = Math.ceil(visibleCount / COLUMNS);
        const totalHeight = PADDING_Y + PADDING_BOTTOM + totalRows * ITEM_H + Math.max(0, totalRows - 1) * SPACING;
        this._gridContainer.set_height(Math.max(totalHeight, 10));
        this._gridContainer.set_width(450);
    }

    close() {
        if (!this._isOpen) return;
        this._isOpen = false;

        this.sourceIcon.emit('menu-state-changed', false);
        if (this.sourceIcon && this.sourceIcon._setIntellihide) {
            this.sourceIcon._setIntellihide(false);
        }

        if (this._trackingId) {
            GLib.source_remove(this._trackingId);
            this._trackingId = null;
        }

        if (this._restackedId) {
            global.display.disconnect(this._restackedId);
            this._restackedId = null;
        }

        if (this._keyPressId) {
            global.stage.disconnect(this._keyPressId);
            this._keyPressId = null;
        }

        this._container.ease({
            scale_x: 0.8,
            scale_y: 0.8,
            opacity: 0,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                global.window_group.remove_child(this);
                this.destroy();
            }
        });
    }
}

class StackIconContainer extends St.Widget {
    static {
        GObject.registerClass({
            Signals: {
                'menu-state-changed': { param_types: [GObject.TYPE_BOOLEAN] }
            }
        }, this);
    }

    get popup() {
        return { isOpen: this._popup ? this._popup._isOpen : false };
    }

    constructor(folderPath, settings) {
        super({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'dash-item-container',
            x_expand: false,
            y_expand: false
        });

        this.folderPath = folderPath;
        this.folderName = folderPath.split('/').pop() || folderPath;
        this._settings = settings;

        this.button = new St.Button({
            style_class: 'app-well-app show-apps',
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER
        });

        this._iconContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true, y_expand: true,
            style_class: 'overview-icon'
        });

        this.icon = new St.Icon({
            gicon: new Gio.ThemedIcon({ name: 'folder' }),
            icon_size: 48
        });

        this._iconContainer.add_child(this.icon);
        this.button.set_child(this._iconContainer);
        this.add_child(this.button);

        // Hover label setup
        this._label = new St.Label({
            style_class: 'dash-label',
            text: this.folderName
        });
        this._label.hide();
        Main.layoutManager.addTopChrome(this._label);

        this.button.connect('notify::hover', () => this._syncLabel());

        this.connect('destroy', () => {
            if (this._label) {
                this._label.destroy();
            }
            if (this._popup) {
                this._popup.close();
                this._popup.destroy();
                this._popup = null;
            }
        });

        this.button.connect('clicked', () => {
            this._toggleFanPopup();
        });
    }

    _toggleFanPopup() {
        console.log(`[Dock Stacks] Fan triggered for ${this.folderPath}`);
        if (this._popup) {
            if (this._popup._isOpen) {
                this._popup.close();
                this._popup = null;
                // Emit false natively to explicitly tell Dash to Dock we closed our popup
                this.emit('menu-state-changed', false);
                this._setIntellihide(false);
                return;
            }
            this._popup = null;
        }

        console.log(`[Dock Stacks] Parsing folder context for UI routing`);

        // Read folder contents dynamically
        const file = Gio.File.new_for_path(this.folderPath);
        const items = [];
        try {
            const enumerator = file.enumerate_children('standard::name,standard::icon,standard::type,standard::content-type,thumbnail::path,time::modified', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            let count = 0;
            // Fetch everything but limit to 500 to prevent pathological memory bloat
            while ((info = enumerator.next_file(null)) !== null && count < 500) {
                if (info.get_is_hidden()) continue;

                const contentType = info.get_content_type();
                let gicon = info.get_icon();
                let isImage = false;

                let imageUri = null;
                if (contentType && contentType.startsWith('image/')) {
                    isImage = true;
                    // Try to get GNOME thumbnail
                    const thumbPathObj = info.get_attribute_byte_string('thumbnail::path');
                    let thumbFile = null;
                    if (thumbPathObj) {
                        thumbFile = Gio.File.new_for_path(thumbPathObj);
                    }

                    if (thumbFile && thumbFile.query_exists(null)) {
                        gicon = new Gio.FileIcon({ file: thumbFile });
                        imageUri = thumbFile.get_uri();
                    } else {
                        // Use actual image file directly
                        const imageFile = file.get_child(info.get_name());
                        gicon = new Gio.FileIcon({ file: imageFile });
                        imageUri = imageFile.get_uri();
                    }
                }

                items.push({
                    name: info.get_name(),
                    icon: gicon || new Gio.ThemedIcon({ name: 'text-x-generic' }),
                    type: info.get_file_type(),
                    isImage: isImage,
                    imageUri: imageUri,
                    uri: file.get_child(info.get_name()).get_uri(),
                    modified: info.get_attribute_uint64('time::modified') || 0
                });
                count++;
            }
        } catch (e) {
            console.error(`[Dock Stacks] Failed reading folder: ${e}`);
        }

        if (items.length === 0) {
            console.log(`[Dock Stacks] Folder is empty, doing nothing.`);
            if (this._popup) {
                this._popup.destroy();
                this._popup = null;
            }
            return;
        }

        console.log(`[Dock Stacks] Loaded ${items.length} items from ${this.folderPath}`);

        const gridMode = this._settings.get_string('grid-mode');
        const threshold = this._settings.get_int('fan-threshold');

        const useGrid = gridMode === 'always' || (gridMode === 'auto' && items.length > threshold);

        if (!useGrid && items.length > threshold) {
            // Fan mode caps out at threshold. We drop the oldest files at the start 
            // of the array, leaving only the newest files at the end.
            items.splice(0, items.length - threshold);
        }

        // Sort chronologically (oldest -> newest)
        items.sort((a, b) => a.modified - b.modified);

        const openInFilesObj = {
            name: 'Open in Files',
            icon: new Gio.ThemedIcon({ name: 'system-file-manager' }),
            type: 'open-folder',
            isImage: false,
            isAction: true,
            folderPath: this.folderPath
        };

        if (useGrid) {
            this._popup = new GridPopup(this);
            // Grid: Newest at top-left
            const sortedGridItems = [...items].reverse();
            sortedGridItems.push(openInFilesObj); // Keep Open At Bottom
            this._popup.open(sortedGridItems);
        } else {
            this._popup = new StackPopup(this);
            // Fan: Newest at bottom physically.
            // When reversed inside StackPopup.open(array.reverse()), index 0 sits at radius 0 (bottom).
            // So we need Newer items at the START of the array handed to open().
            const sortedFanItems = [...items].reverse(); // Newest first
            sortedFanItems.push(openInFilesObj); // Append "Open in Files", it will flip to the top!
            this._popup.open(sortedFanItems);
        }

        // Emit true natively to freeze Dash to Dock autohide timers
        this.emit('menu-state-changed', true);
        this._setIntellihide(true);
    }

    _setIntellihide(isOpen) {
        // Fallback for native dash
        try {
            if (Main.overview.dash) {
                Main.overview.dash.emit(isOpen ? 'menu-opened' : 'menu-closed');
                Main.overview.dash.requiresVisibility = isOpen;
            }
        } catch (e) { }

        // Dash to Dock / Ubuntu Dock bypass via recursive Clutter search
        const findDash = (actor) => {
            if (!actor) return false;
            // Native extension properties
            if (actor.name === 'dashtodockContainer' && actor.dash) {
                actor.dash.emit(isOpen ? 'menu-opened' : 'menu-closed');
                actor.dash.requiresVisibility = isOpen;
                return true;
            }
            const children = actor.get_children();
            for (let i = 0; i < children.length; i++) {
                if (findDash(children[i])) return true;
            }
            return false;
        };

        try {
            findDash(Main.layoutManager.uiGroup);
        } catch (e) { }
    }

    _syncLabel() {
        if (this.button.hover) {
            this._label.show();
            // Small timeout to allow size allocation
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (!this.button || !this.button.hover || !this._label) return GLib.SOURCE_REMOVE;

                const [x, y] = this.button.get_transformed_position();
                const [w, h] = this.button.get_transformed_size();

                // Native dash labels sit `yOffset` above the dock's top edge
                // The native GNOME offset is calculated from the theme (-y-offset), usually 8px
                const themeNode = this._label.get_theme_node();
                const defaultYOffset = themeNode.get_length('-y-offset') || 8;

                // Fine-tuning requested by user
                const yOffset = defaultYOffset + 2;

                this._label.set_position(
                    x + Math.floor((w - this._label.width) / 2),
                    y - this._label.height - yOffset
                );
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this._label.hide();
        }
    }
}

export default class DockStacksExtension extends Extension {
    enable() {
        console.log(`[Dock Stacks] Enabling extension...`);
        this._settings = this.getSettings('org.gnome.shell.extensions.dock-stacks');
        this._stackIcons = [];
        this._dashBox = null;
        this._enableRetryId = null;

        // Wait 1.5s before injecting into the dash.
        // Even if _box exists immediately, Dash-to-Dock and other dock extensions
        // may not have finished initializing their layout yet.
        // This delay is imperceptible but prevents icons from being silently dropped.
        this._enableRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._enableRetryId = null;
            let retries = 0;

            const trySync = () => {
                try {
                    const box = Main.overview.dash._box;
                    if (box) this._dashBox = box;
                } catch (e) {
                    this._dashBox = null;
                }

                if (this._dashBox) {
                    console.log(`[Dock Stacks] Syncing stacks (startup retry ${retries}).`);
                    this._syncStacks();
                    return false; // GLib.SOURCE_REMOVE
                }

                retries++;
                if (retries >= 15) {
                    console.error(`[Dock Stacks] Dash unavailable after 15 retries.`);
                    return false;
                }
                return true; // GLib.SOURCE_CONTINUE
            };

            // Try once now, then poll every 500ms if not ready
            if (!trySync()) {
                // trySync returned false = already found and synced
                return false;
            }
            // Not found yet, keep polling
            this._enableRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, trySync);
            return false; // Don't repeat the outer 1500ms timer
        });

        this._settingsChangedId = this._settings.connect('changed::configured-folders', () => {
            this._syncStacks();
        });

        // Re-sync stacks when the GNOME overview opens.
        // The overview dash may not have our icons if the dock extension re-initializes.
        this._overviewShowingId = Main.overview.connect('showing', () => {
            // Check if any of our icons are still in the box; re-sync if not
            if (this._stackIcons.length > 0 && this._dashBox) {
                const firstIcon = this._stackIcons[0];
                if (!this._dashBox.contains(firstIcon)) {
                    console.log('[Dock Stacks] Overview opened: icons missing from dash, re-syncing.');
                    this._syncStacks();
                }
            }
        });
    }

    _syncStacks() {
        this._cleanStacks();

        // Refresh the dash box reference — dock extensions may reinitialize it.
        // Dash-to-Dock nests the inner dash: Main.overview.dash.dash._box
        // Standard GNOME dash: Main.overview.dash._box
        try {
            this._dashBox =
                Main.overview.dash.dash?._box ||
                Main.overview.dash._box ||
                this._dashBox; // keep existing ref as last resort
        } catch (e) {
            // _dashBox stays as-is
        }

        const folders = this._settings.get_strv('configured-folders');
        for (const folder of folders) {
            try {
                const stackIcon = new StackIconContainer(folder, this._settings);
                this._stackIcons.push(stackIcon);
                // Append it to dash container safely
                if (this._dashBox) {
                    this._dashBox.add_child(stackIcon);
                }
            } catch (e) {
                console.error(`[Dock Stacks] Failed to add stack for ${folder}:`, e);
            }
        }
    }

    _cleanStacks() {
        if (this._stackIcons) {
            for (const icon of this._stackIcons) {
                if (this._dashBox && this._dashBox.contains(icon)) {
                    this._dashBox.remove_child(icon);
                }
                icon.destroy();
            }
        }
        this._stackIcons = [];
    }

    disable() {
        console.log(`[Dock Stacks] Disabling extension...`);

        if (this._enableRetryId) {
            GLib.source_remove(this._enableRetryId);
            this._enableRetryId = null;
        }

        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = null;
        }

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        this._cleanStacks();
        this._settings = null;
    }
}
