import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

// ─── GObject Lifetime Helpers ───────────────────────────────────────────────

/**
 * Check if a GObject/Clutter.Actor is still alive (not finalized/disposed).
 * Mutter can destroy MetaWindowActor at any time; accessing properties on a
 * disposed GObject throws.
 */
function _isActorAlive(actor) {
    try {
        if (!actor)
            return false;
        if (typeof actor.is_finalized === 'function')
            return !actor.is_finalized();
        void actor.visible;
        return true;
    } catch (_) {
        return false;
    }
}

// ─── Drag & Drop Helpers ────────────────────────────────────────────────────

/**
 * Query Nautilus's current directory for a given MetaWindow via the
 * org.freedesktop.FileManager1 D-Bus interface.
 * Returns a string path or null.
 */
function _getNautilusDirectoryForWindow(metaWindow) {
    // Try OpenWindowsWithLocations first (maps window object paths -> location URIs)
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
            const windowsMap = variant.deep_unpack();

            for (const [, uris] of Object.entries(windowsMap)) {
                if (uris && uris.length > 0) {
                    const gfile = Gio.File.new_for_uri(uris[0]);
                    const path = gfile.get_path();
                    if (path)
                        return path;
                }
            }
        }
    } catch (_) {}

    // Fallback: OpenLocations (flat array of all open URIs)
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
                if (path)
                    return path;
            }
        }
    } catch (_) {}

    return null;
}

/**
 * Perform the file drop action based on where the cursor ended up.
 */
function _handleFileDrop(data, dropX, dropY, modifiers) {
    if (!data.uri) return;

    // Ctrl = copy, default = move
    const isCopy = !!(modifiers & Clutter.ModifierType.CONTROL_MASK);

    const sourceFile = Gio.File.new_for_uri(data.uri);
    if (!sourceFile.query_exists(null)) {
        console.error(`[Dock Stacks] Source file does not exist: ${data.uri}`);
        return;
    }

    // Topmost window under cursor
    const windowActors = global.get_window_actors();
    let targetWindow = null;

    for (let i = windowActors.length - 1; i >= 0; i--) {
        try {
            const actor = windowActors[i];
            if (!_isActorAlive(actor)) continue;
            const meta = actor.get_meta_window();
            if (!meta || meta.is_hidden() || meta.minimized) continue;

            const rect = meta.get_frame_rect();
            if (dropX >= rect.x && dropX <= rect.x + rect.width &&
                dropY >= rect.y && dropY <= rect.y + rect.height) {
                targetWindow = meta;
                break;
            }
        } catch (_) {
            continue;
        }
    }

    if (!targetWindow) {
        // No window under cursor -> drop to Desktop
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
            if (isCopy)
                sourceFile.copy(destFile, Gio.FileCopyFlags.NONE, null, null);
            else
                sourceFile.move(destFile, Gio.FileCopyFlags.NONE, null, null);
        } catch (e) {
            console.error(`[Dock Stacks] Failed to copy to Desktop: ${e}`);
        }
        return;
    }

    // Identify target window using all available methods (Wayland often lacks WM_CLASS)
    const wmClass = (targetWindow.get_wm_class() || '').toLowerCase();
    let gtkAppId = '';
    let sandboxId = '';
    try { gtkAppId = (targetWindow.get_gtk_application_id() || '').toLowerCase(); } catch (_) {}
    try { sandboxId = (targetWindow.get_sandboxed_app_id() || '').toLowerCase(); } catch (_) {}

    const isNautilus = wmClass.includes('nautilus') || wmClass.includes('files') ||
        gtkAppId.includes('nautilus') || gtkAppId.includes('org.gnome.nautilus') ||
        sandboxId.includes('nautilus');

    if (isNautilus) {
        const nautilusDir = _getNautilusDirectoryForWindow(targetWindow);
        if (nautilusDir) {
            const destDir = Gio.File.new_for_path(nautilusDir);
            const destFile = destDir.get_child(sourceFile.get_basename());
            try {
                if (isCopy)
                    sourceFile.copy(destFile, Gio.FileCopyFlags.NONE, null, null);
                else
                    sourceFile.move(destFile, Gio.FileCopyFlags.NONE, null, null);
            } catch (e) {
                console.error(`[Dock Stacks] Failed to move to Nautilus dir: ${e}`);
            }
            return;
        }
        console.error('[Dock Stacks] Could not determine Nautilus directory, cancelling drop.');
        return;
    }

    // Non-Nautilus app -> copy file path to clipboard.
    // True Wayland cross-process DnD from the compositor is not possible.
    const clipboard = St.Clipboard.get_default();
    const filePath = sourceFile.get_path();
    clipboard.set_text(St.ClipboardType.CLIPBOARD, filePath);
}

/**
 * Make an itemContainer manually draggable using raw captured events.
 * St.Button internally consumes button-press-event, blocking Clutter.DragAction.
 * So we track press->motion->release via global.stage captured-event instead.
 */
function _setupDragAction(itemContainer, data, popup) {
    if (data.isAction) return;

    let pressX = 0, pressY = 0;
    let isPressed = false;
    let isDragging = false;
    let dragClone = null;
    let capturedEventId = null;

    const DRAG_THRESHOLD = 12;

    itemContainer.connect('button-press-event', (actor, event) => {
        if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
        [pressX, pressY] = event.get_coords();
        isPressed = true;
        isDragging = false;

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
                    isDragging = true;
                    popup._isDragging = true;

                    if (popup._eventBlocker) popup._eventBlocker.reactive = false;

                    dragClone = new Clutter.Clone({
                        source: itemContainer,
                        opacity: 180,
                    });
                    const [ix, iy] = itemContainer.get_transformed_position();
                    dragClone.set_position(ix, iy);
                    Main.uiGroup.add_child(dragClone);

                    itemContainer.set_opacity(80);
                }

                if (isDragging && dragClone) {
                    const [cloneW, cloneH] = [dragClone.width, dragClone.height];
                    dragClone.set_position(mx - cloneW / 2, my - cloneH / 2);
                    return Clutter.EVENT_STOP;
                }

                return Clutter.EVENT_PROPAGATE;
            }

            if (type === Clutter.EventType.BUTTON_RELEASE) {
                if (!isPressed) return Clutter.EVENT_PROPAGATE;

                const wasDragging = isDragging;
                const [releaseX, releaseY] = ev.get_coords();
                const modifiers = ev.get_state();

                isPressed = false;
                isDragging = false;
                popup._isDragging = false;

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
                    const snapBackDist = Math.sqrt(
                        (releaseX - pressX) ** 2 + (releaseY - pressY) ** 2
                    );
                    if (snapBackDist < 30)
                        return Clutter.EVENT_STOP;

                    _handleFileDrop(data, releaseX, releaseY, modifiers);
                    popup.close();
                    return Clutter.EVENT_STOP;
                }

                return Clutter.EVENT_PROPAGATE;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        return Clutter.EVENT_PROPAGATE;
    });

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

        // window_group so Sushi previews can layer on top
        global.window_group.add_child(this);

        this._syncZOrder = () => {
            if (!this._isOpen) return;
            if (!_isActorAlive(this)) return;
            let sushiActor = null;
            let topAppActor = null;

            for (const actor of global.get_window_actors()) {
                try {
                    if (!_isActorAlive(actor)) continue;
                    if (actor.get_parent() !== global.window_group) continue;
                    const win = actor.meta_window;
                    if (!win) continue;

                    topAppActor = actor;

                    const wmClass = win.get_wm_class() ? win.get_wm_class().toLowerCase() : '';
                    const title = win.get_title() ? win.get_title().toLowerCase() : '';

                    if (wmClass.includes('sushi') || wmClass.includes('previewer') || title.includes('sushi')) {
                        sushiActor = actor;
                    }
                } catch (_) {
                    continue;
                }
            }

            if (sushiActor && _isActorAlive(sushiActor)) {
                global.window_group.set_child_below_sibling(this, sushiActor);
                this._sushiWasOpen = true;
            } else {
                if (topAppActor && _isActorAlive(topAppActor)) {
                    global.window_group.set_child_above_sibling(this, topAppActor);
                }
                if (this._sushiWasOpen) {
                    this._sushiWasOpen = false;
                    if (_isActorAlive(this)) this.grab_key_focus();
                }
            }
        };

        this._restackedId = global.display.connect('restacked', this._syncZOrder);

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
            try {
                if (!_isActorAlive(this) || !this.sourceIcon || !_isActorAlive(this.sourceIcon.button))
                    return GLib.SOURCE_REMOVE;
                const [newX, newY] = this.sourceIcon.button.get_transformed_position();
                const newOriginX = newX + (sourceW / 2);
                if (newOriginX !== lastOriginX || newY !== lastOriginY) {
                    this._fanContainer.translation_x = newOriginX - originX;
                    this._fanContainer.translation_y = newY - originY;
                    lastOriginX = newOriginX;
                    lastOriginY = newY;
                }
            } catch (_) {
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });

        let index = 0;

        const displayItems = itemsData;

        // macOS fan always arcs to the right
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

                if (data.isAction)
                    iconWidget.set_style('');
                else
                    iconWidget.set_style('border-radius: 4px;');
            }

            const labelWidget = new St.Label({
                text: data.name,
                style_class: 'dash-label',
                y_align: Clutter.ActorAlign.CENTER,
                style: 'margin-right: 12px;'
            });

            const itemBox = new St.BoxLayout({
                vertical: false,
                y_align: Clutter.ActorAlign.CENTER
            });
            itemBox.add_child(labelWidget);
            itemBox.add_child(iconWidget);

            const itemContainer = new St.Button({
                reactive: true,
                can_focus: true,
                track_hover: true,
                child: itemBox,
                style_class: 'app-well-app',
                height: 64
            });

            itemContainer._isFanOpened = false;

            _setupDragAction(itemContainer, data, this);

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

            const gap = 4;

            // Parabolic arc curve
            const xShift = Math.pow(index, 1.8) * 2.5;

            const tiltAngle = index * 2.5;
            const destY = originY - ((index + 1) * (64 + gap));

            const idx = index;
            this._fanContainer.add_child(itemContainer);

            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (!itemContainer || !_isActorAlive(itemContainer)) return GLib.SOURCE_REMOVE;
                if (!this._isOpen) return GLib.SOURCE_REMOVE;

                const [, natW] = itemContainer.get_preferred_width(-1);

                // Pivot at icon center (icon is ~64px wide, right-aligned)
                const pivotX = 1.0 - (32 / natW);
                itemContainer.set_pivot_point(pivotX, 0.5);

                // Offscreen redirect for anti-aliased rotation
                itemContainer.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);

                const destX = originX + xShift - natW + 32;

                const startX = originX - natW + 32;
                const startY = originY + (sourceH / 2) - 32;

                itemContainer.set_position(startX, startY);
                itemContainer.set_scale(0.1, 0.1);
                itemContainer.rotation_angle_z = tiltAngle;
                itemContainer.set_opacity(0);

                itemContainer.ease({
                    x: destX,
                    y: destY,
                    scale_x: 1,
                    scale_y: 1,
                    opacity: 255,
                    duration: 140,
                    delay: idx * 11,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        itemContainer._isFanOpened = true;
                    }
                });

                return GLib.SOURCE_REMOVE;
            });

            index++;
        }

        // Spacebar -> GNOME Sushi preview on hovered item.
        // Captured event intercepts before Wayland routes to the focused app.
        this._keyPressId = global.stage.connect('captured-event', (actor, event) => {
            if (event.type() !== Clutter.EventType.KEY_PRESS) return Clutter.EVENT_PROPAGATE;

            // Sushi owns the keyboard while it's open
            if (this._sushiWasOpen) return Clutter.EVENT_PROPAGATE;

            if (event.get_key_symbol() === Clutter.KEY_space) {
                const children = this._fanContainer.get_children();
                const [mx, my] = global.get_pointer();

                for (let i = 0; i < children.length; i++) {
                    const child = children[i];

                    const [, x, y] = child.get_transformed_position();
                    const [, w, h] = child.get_transformed_size();
                    const isHovered = child.hover || (mx >= x && mx <= x + w && my >= y && my <= y + h);

                    if (isHovered) {
                        const itemData = displayItems[i];
                        if (!itemData.isAction && itemData.uri) {
                            try {
                                Gio.DBus.session.call('org.gnome.NautilusPreviewer',
                                    '/org/gnome/NautilusPreviewer',
                                    'org.gnome.NautilusPreviewer',
                                    'ShowFile',
                                    new GLib.Variant('(sib)', [itemData.uri, 0, false]),
                                    null,
                                    Gio.DBusCallFlags.NONE,
                                    -1,
                                    null,
                                    (connection, res) => {
                                        try { connection.call_finish(res); } catch (_) {}
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

        if (this._trackingId) {
            GLib.source_remove(this._trackingId);
            this._trackingId = null;
        }

        if (this._allocationId && this.sourceIcon && _isActorAlive(this.sourceIcon.button)) {
            try {
                this.sourceIcon.button.disconnect(this._allocationId);
            } catch (_) {}
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

        this._syncZOrder = null;

        try {
            if (this.sourceIcon && _isActorAlive(this.sourceIcon)) {
                this.sourceIcon.emit('menu-state-changed', false);
                if (this.sourceIcon._setIntellihide)
                    this.sourceIcon._setIntellihide(false);
            }
        } catch (_) {}

        let originX = 0, originY = 0, sourceH = 0;
        let canAnimate = false;
        try {
            if (this.sourceIcon && _isActorAlive(this.sourceIcon.button)) {
                const [sourceX, sourceY] = this.sourceIcon.button.get_transformed_position();
                originY = sourceY;
                const [sourceW, sh] = this.sourceIcon.button.get_transformed_size();
                sourceH = sh;
                originX = sourceX + (sourceW / 2);
                canAnimate = true;
            }
        } catch (_) { canAnimate = false; }

        const children = this._fanContainer.get_children();
        if (canAnimate) {
            for (const child of children) {
                child._isFanOpened = false;
                const [, natW] = child.get_preferred_width(-1);
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
                    onComplete: () => {
                        if (_isActorAlive(child)) child.destroy();
                    }
                });
            }
        } else {
            for (const child of children) {
                if (_isActorAlive(child)) child.destroy();
            }
        }

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            try {
                if (_isActorAlive(this)) {
                    if (this.get_parent() === global.window_group)
                        global.window_group.remove_child(this);
                    this.destroy();
                }
            } catch (_) {}
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

        // BinLayout so search entry floats on top of the scrollview
        this._container = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style: 'background-color: rgba(30, 30, 30, 0.9); border-radius: 16px; border: 1px solid rgba(255,255,255,0.08); width: 480px; height: 600px;',
            opacity: 0
        });

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
            vscrollbar_policy: St.PolicyType.NEVER,
            enable_mouse_scrolling: true,
            x_expand: true,
            y_expand: true,
            style: 'margin: 0px;'
        });

        this._gridContainer = new St.Widget({
            style: 'padding: 8px;'
        });

        // Wrapper to satisfy St.Scrollable interface in GNOME 47+
        this._scrollWrapper = new St.BoxLayout({
            vertical: true,
            x_expand: false,
            y_expand: false
        });
        this._scrollWrapper.add_child(this._gridContainer);

        this._scrollView.set_child(this._scrollWrapper);

        this._container.add_child(this._scrollView);
        this._container.add_child(this._searchWrapper);

        this.add_child(this._container);
    }

    open(itemsData) {
        if (this._isOpen) return;
        this._isOpen = true;
        this._items = itemsData;
        this._sushiWasOpen = false;

        global.window_group.add_child(this);

        this._syncZOrder = () => {
            if (!this._isOpen) return;
            if (!_isActorAlive(this)) return;
            let sushiActor = null;
            let topAppActor = null;

            for (const actor of global.get_window_actors()) {
                try {
                    if (!_isActorAlive(actor)) continue;
                    if (actor.get_parent() !== global.window_group) continue;
                    const win = actor.meta_window;
                    if (!win) continue;

                    topAppActor = actor;

                    const wmClass = win.get_wm_class() ? win.get_wm_class().toLowerCase() : '';
                    const title = win.get_title() ? win.get_title().toLowerCase() : '';

                    if (wmClass.includes('sushi') || wmClass.includes('previewer') || title.includes('sushi')) {
                        sushiActor = actor;
                    }
                } catch (_) {
                    continue;
                }
            }

            if (sushiActor && _isActorAlive(sushiActor)) {
                global.window_group.set_child_below_sibling(this, sushiActor);
                this._sushiWasOpen = true;
            } else {
                if (topAppActor && _isActorAlive(topAppActor)) {
                    global.window_group.set_child_above_sibling(this, topAppActor);
                }
                if (this._sushiWasOpen) {
                    this._sushiWasOpen = false;
                    if (_isActorAlive(this)) {
                        this.grab_key_focus();
                        this._searchEntry.grab_key_focus();
                    }
                }
            }
        };

        this._restackedId = global.display.connect('restacked', this._syncZOrder);
        this._syncZOrder();

        this.grab_key_focus();
        this._searchEntry.grab_key_focus();

        const [sourceX, sourceY] = this.sourceIcon.button.get_transformed_position();
        const [sourceW, sourceH] = this.sourceIcon.button.get_transformed_size();

        const originX = sourceX + (sourceW / 2);
        const originY = sourceY;

        let lastOriginX = originX;
        let lastOriginY = originY;

        this._trackingId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (!this._isOpen) return GLib.SOURCE_REMOVE;
            try {
                if (!_isActorAlive(this) || !this.sourceIcon || !_isActorAlive(this.sourceIcon.button))
                    return GLib.SOURCE_REMOVE;
                const [newX, newY] = this.sourceIcon.button.get_transformed_position();
                const newOriginX = newX + (sourceW / 2);
                if (newOriginX !== lastOriginX || newY !== lastOriginY) {
                    this._container.translation_x = newOriginX - originX;
                    this._container.translation_y = newY - originY;
                    lastOriginX = newOriginX;
                    lastOriginY = newY;
                }
            } catch (_) {
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._container || !this._isOpen || !_isActorAlive(this)) return GLib.SOURCE_REMOVE;
            const [, natW] = this._container.get_preferred_width(-1);
            const [, natH] = this._container.get_preferred_height(-1);

            const destX = originX - (natW / 2);
            const destY = originY - natH - 24;

            const dockCenterY = originY + (sourceH / 2);
            const startX = originX - (natW / 2);
            const startY = dockCenterY - natH;

            this._container.set_position(startX, startY);
            this._container.set_opacity(0);
            this._container.set_scale(0.1, 0.1);
            this._container.set_pivot_point(0.5, 1.0);

            this._container.ease({
                x: destX,
                y: destY,
                scale_x: 1,
                scale_y: 1,
                opacity: 255,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC
            });

            return GLib.SOURCE_REMOVE;
        });

        this._items.forEach((data, index) => {
            let iconWidget;

            if (data.isImage && data.imageUri) {
                const img = new St.Widget({
                    style: `background-image: url("${data.imageUri}"); background-size: cover; background-position: center; border-radius: 4px; border: 3px solid #ffffff; width: 64px; height: 64px; margin: 0;`
                });
                iconWidget = new St.Bin({
                    child: img,
                    style: 'border-radius: 6px; padding: 0;'
                });
            } else {
                iconWidget = new St.Icon({
                    gicon: data.icon,
                    icon_size: 64,
                    style_class: 'stack-item-icon'
                });

                if (data.isAction)
                    iconWidget.set_style('');
                else
                    iconWidget.set_style('border-radius: 4px;');
            }

            const nameBox = new St.BoxLayout({ vertical: true });

            const labelWidget = new St.Label({
                text: data.name,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.START,
                style: 'color: white; font-size: 13px; text-align: center; max-width: 80px;'
            });
            labelWidget.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            labelWidget.clutter_text.line_wrap = true;
            labelWidget.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;

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

            itemContainer._data = data;

            _setupDragAction(itemContainer, data, this);
            itemContainer.hoverTargetScale = 1.05;
            itemContainer.set_opacity(0);

            itemContainer.connect('notify::hover', () => {
                const targetScale = itemContainer.hover ? itemContainer.hoverTargetScale : 1.0;
                itemContainer.set_pivot_point(0.5, 0.5);
                itemContainer.ease({
                    scale_x: targetScale,
                    scale_y: targetScale,
                    duration: 120,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });

                // Only steal focus if mouse is actively moving, not on layout reshuffle
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

        // Captured events: Spacebar -> Sushi, outside-click -> dismiss
        this._keyPressId = global.stage.connect('captured-event', (actor, event) => {
            const type = event.type();

            if (type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.TOUCH_BEGIN) {
                const [x, y] = event.get_coords();
                const [cx, cy] = this._container.get_transformed_position();
                const [cw, ch] = this._container.get_transformed_size();

                if (x < cx || x > cx + cw || y < cy || y > cy + ch) {
                    if (this._isDragging) return Clutter.EVENT_PROPAGATE;

                    // Let the source dock icon's own click handler toggle
                    if (this.sourceIcon && this.sourceIcon.button) {
                        const [sx, sy] = this.sourceIcon.button.get_transformed_position();
                        const [sw, sh] = this.sourceIcon.button.get_transformed_size();
                        if (x >= sx && x <= sx + sw && y >= sy && y <= sy + sh) {
                            return Clutter.EVENT_PROPAGATE;
                        }
                    }

                    this.close();
                    return Clutter.EVENT_PROPAGATE;
                }
            }

            if (type === Clutter.EventType.MOTION) {
                if (this._mousePosAtLastType) {
                    const [x, y] = event.get_coords();
                    const dx = x - this._mousePosAtLastType[0];
                    const dy = y - this._mousePosAtLastType[1];
                    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                        this._mousePosAtLastType = null;

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

            // Sushi owns the keyboard while it's open
            if (this._sushiWasOpen) return Clutter.EVENT_PROPAGATE;

            if (event.get_key_symbol() === Clutter.KEY_space) {
                const children = this._gridContainer.get_children();
                const [mx, my] = global.get_pointer();

                for (let i = 0; i < children.length; i++) {
                    const child = children[i];
                    const [, x, y] = child.get_transformed_position();
                    const [, w, h] = child.get_transformed_size();
                    const isHovered = child.hover || (mx >= x && mx <= x + w && my >= y && my <= y + h);

                    if (isHovered) {
                        const itemData = child._data;
                        if (itemData && !itemData.isAction && itemData.uri) {
                            try {
                                Gio.DBus.session.call('org.gnome.NautilusPreviewer',
                                    '/org/gnome/NautilusPreviewer',
                                    'org.gnome.NautilusPreviewer',
                                    'ShowFile',
                                    new GLib.Variant('(sib)', [itemData.uri, 0, false]),
                                    null,
                                    Gio.DBusCallFlags.NONE,
                                    -1,
                                    null,
                                    (connection, res) => {
                                        try { connection.call_finish(res); } catch (_) {}
                                    });
                            } catch (e) {
                                console.error('[Dock Stacks] Sushi DBus spawn error:', e);
                            }
                        }
                        return Clutter.EVENT_STOP;
                    }
                }
            }

            // Ctrl+F -> focus search bar
            const isCtrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
            if (isCtrl && event.get_key_symbol() === Clutter.KEY_f) {
                this._mousePosAtLastType = global.get_pointer();
                this._searchEntry.grab_key_focus();
                return Clutter.EVENT_STOP;
            }

            // Process search bar key events after Sushi/spacebar checks
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

        this._filterGrid('');
    }

    _filterGrid(term) {
        const lowerTerm = term.toLowerCase();
        let visibleCount = 0;
        const COLUMNS = 4;
        const PADDING_X = 16;
        const PADDING_Y = 72;
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

        const totalRows = Math.ceil(visibleCount / COLUMNS);
        const totalHeight = PADDING_Y + PADDING_BOTTOM + totalRows * ITEM_H + Math.max(0, totalRows - 1) * SPACING;
        this._gridContainer.set_height(Math.max(totalHeight, 10));
        this._gridContainer.set_width(450);
    }

    close() {
        if (!this._isOpen) return;
        this._isOpen = false;

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

        this._syncZOrder = null;

        try {
            if (this.sourceIcon && _isActorAlive(this.sourceIcon)) {
                this.sourceIcon.emit('menu-state-changed', false);
                if (this.sourceIcon._setIntellihide)
                    this.sourceIcon._setIntellihide(false);
            }
        } catch (_) {}

        if (_isActorAlive(this._container)) {
            this._container.ease({
                scale_x: 0.8,
                scale_y: 0.8,
                opacity: 0,
                duration: 150,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    try {
                        if (_isActorAlive(this)) {
                            if (this.get_parent() === global.window_group)
                                global.window_group.remove_child(this);
                            this.destroy();
                        }
                    } catch (_) {}
                }
            });
        } else {
            try {
                if (_isActorAlive(this)) {
                    if (this.get_parent() === global.window_group)
                        global.window_group.remove_child(this);
                    this.destroy();
                }
            } catch (_) {}
        }
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

        this._label = new St.Label({
            style_class: 'dash-label',
            text: this.folderName
        });
        this._label.hide();
        Main.layoutManager.addTopChrome(this._label);

        this.button.connect('notify::hover', () => this._syncLabel());

        this.connect('destroy', () => {
            if (this._label && _isActorAlive(this._label)) {
                this._label.destroy();
                this._label = null;
            }
            if (this._popup) {
                try {
                    if (this._popup._isOpen) this._popup.close();
                    else if (_isActorAlive(this._popup)) this._popup.destroy();
                } catch (_) {}
                this._popup = null;
            }
        });

        this.button.connect('clicked', () => {
            this._toggleFanPopup();
        });
    }

    _toggleFanPopup() {
        if (this._popup) {
            if (this._popup._isOpen) {
                this._popup.close();
                this._popup = null;
                this.emit('menu-state-changed', false);
                this._setIntellihide(false);
                return;
            }
            this._popup = null;
        }

        const file = Gio.File.new_for_path(this.folderPath);
        const items = [];
        try {
            const enumerator = file.enumerate_children('standard::name,standard::icon,standard::type,standard::content-type,thumbnail::path,time::modified', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            let count = 0;
            // Cap at 500 to prevent pathological memory bloat
            while ((info = enumerator.next_file(null)) !== null && count < 500) {
                if (info.get_is_hidden()) continue;

                const contentType = info.get_content_type();
                let gicon = info.get_icon();
                let isImage = false;

                let imageUri = null;
                if (contentType && contentType.startsWith('image/')) {
                    isImage = true;
                    const thumbPathObj = info.get_attribute_byte_string('thumbnail::path');
                    let thumbFile = null;
                    if (thumbPathObj) {
                        thumbFile = Gio.File.new_for_path(thumbPathObj);
                    }

                    if (thumbFile && thumbFile.query_exists(null)) {
                        gicon = new Gio.FileIcon({ file: thumbFile });
                        imageUri = thumbFile.get_uri();
                    } else {
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
            if (this._popup) {
                this._popup.destroy();
                this._popup = null;
            }
            return;
        }

        const gridMode = this._settings.get_string('grid-mode');
        const threshold = this._settings.get_int('fan-threshold');

        const useGrid = gridMode === 'always' || (gridMode === 'auto' && items.length > threshold);

        if (!useGrid && items.length > threshold) {
            // Fan caps at threshold; drop oldest (start of array)
            items.splice(0, items.length - threshold);
        }

        // Oldest -> newest
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
            const sortedGridItems = [...items].reverse();
            sortedGridItems.push(openInFilesObj);
            this._popup.open(sortedGridItems);
        } else {
            this._popup = new StackPopup(this);
            const sortedFanItems = [...items].reverse();
            sortedFanItems.push(openInFilesObj);
            this._popup.open(sortedFanItems);
        }

        // Freeze Dash to Dock autohide
        this.emit('menu-state-changed', true);
        this._setIntellihide(true);
    }

    _setIntellihide(isOpen) {
        try {
            if (Main.overview.dash) {
                Main.overview.dash.emit(isOpen ? 'menu-opened' : 'menu-closed');
                Main.overview.dash.requiresVisibility = isOpen;
            }
        } catch (_) {}

        // Dash to Dock / Ubuntu Dock bypass via recursive Clutter search
        const findDash = (actor) => {
            if (!actor) return false;
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
        } catch (_) {}
    }

    _syncLabel() {
        if (this.button.hover) {
            this._label.show();
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (!this.button || !_isActorAlive(this.button) || !this.button.hover || !this._label) return GLib.SOURCE_REMOVE;

                const [x, y] = this.button.get_transformed_position();
                const [w, h] = this.button.get_transformed_size();

                const themeNode = this._label.get_theme_node();
                const defaultYOffset = themeNode.get_length('-y-offset') || 8;
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
        this._settings = this.getSettings('org.gnome.shell.extensions.dock-stacks');
        this._stackIcons = [];
        this._dashBox = null;
        this._enableRetryId = null;

        // Wait for D2D and other dock extensions to finish layout init
        this._enableRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this._enableRetryId = null;
            let retries = 0;

            const trySync = () => {
                try {
                    const box = Main.overview.dash._box;
                    if (box) this._dashBox = box;
                } catch (_) {
                    this._dashBox = null;
                }

                if (this._dashBox) {
                    this._syncStacks();
                    return false;
                }

                retries++;
                if (retries >= 15) {
                    console.error('[Dock Stacks] Dash unavailable after 15 retries.');
                    return false;
                }
                return true;
            };

            if (!trySync()) {
                return false;
            }
            this._enableRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, trySync);
            return false;
        });

        this._settingsChangedId = this._settings.connect('changed::configured-folders', () => {
            this._syncStacks();
        });

        this._overviewShowingId = Main.overview.connect('showing', () => {
            // D2D's overview animation runs asynchronously after 'showing';
            // override its fade after it finishes (~300ms typical)
            if (this._overviewFixTimerId) {
                GLib.source_remove(this._overviewFixTimerId);
            }
            this._overviewFixTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                for (const icon of this._stackIcons) {
                    try {
                        if (!_isActorAlive(icon)) continue;
                        icon.remove_all_transitions();
                        icon.show();
                        icon.set_opacity(255);
                    } catch (_) {}
                }
                this._overviewFixTimerId = null;
                return false;
            });
        });

        this._overviewShownId = Main.overview.connect('shown', () => {
            // Belt-and-suspenders: force visible after animation fully completes
            for (const icon of this._stackIcons) {
                try {
                    if (!_isActorAlive(icon)) continue;
                    icon.remove_all_transitions();
                    icon.show();
                    icon.set_opacity(255);
                } catch (_) {}
            }
        });
    }

    _syncStacks() {
        this._cleanStacks();

        // Refresh dash box ref; D2D nests it: Main.overview.dash.dash._box
        try {
            this._dashBox =
                Main.overview.dash.dash?._box ||
                Main.overview.dash._box ||
                this._dashBox;
        } catch (_) {}

        const folders = this._settings.get_strv('configured-folders');
        for (const folder of folders) {
            try {
                const stackIcon = new StackIconContainer(folder, this._settings);
                this._stackIcons.push(stackIcon);
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
                try {
                    if (!_isActorAlive(icon)) continue;
                    if (this._dashBox && _isActorAlive(this._dashBox) && this._dashBox.contains(icon)) {
                        this._dashBox.remove_child(icon);
                    }
                    icon.destroy();
                } catch (_) {}
            }
        }
        this._stackIcons = [];
    }

    disable() {
        if (this._enableRetryId) {
            GLib.source_remove(this._enableRetryId);
            this._enableRetryId = null;
        }

        if (this._overviewFixTimerId) {
            GLib.source_remove(this._overviewFixTimerId);
            this._overviewFixTimerId = null;
        }

        if (this._overviewShowingId) {
            Main.overview.disconnect(this._overviewShowingId);
            this._overviewShowingId = null;
        }

        if (this._overviewShownId) {
            Main.overview.disconnect(this._overviewShownId);
            this._overviewShownId = null;
        }

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        this._cleanStacks();
        this._settings = null;
    }
}
