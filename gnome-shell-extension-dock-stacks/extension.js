import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

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
            const iconWidget = new St.Icon({
                gicon: data.icon,
                icon_size: 48,
                style_class: 'stack-item-icon'
            });

            if (data.isImage) {
                // Apply a frame around image thumbnails exactly like Nautilus
                iconWidget.set_style('border: 3px solid #ffffff; border-radius: 4px; background-color: #ffffff; box-shadow: 0px 4px 6px rgba(0,0,0,0.6); padding: 0;');
            } else if (data.isAction) {
                // Apply ONLY the drop shadow, no circular background
                iconWidget.set_style('icon-shadow: 0px 4px 6px rgba(0,0,0,0.6);');
            } else {
                iconWidget.set_style('border-radius: 4px; icon-shadow: 0px 4px 6px rgba(0,0,0,0.6);');
            }

            const labelWidget = new St.Label({
                text: data.name,
                y_align: Clutter.ActorAlign.CENTER
            });
            // Mimic macOS translucent pill
            // We removed box-shadow to prevent Wayland FBO freezes on label invalidations
            labelWidget.set_style('background-color: rgba(0,0,0,0.5); color: white; border-radius: 12px; padding: 4px 12px; margin-right: 12px; border: 1px solid rgba(255,255,255,0.2); font-weight: bold;');

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

        // Base container for the rounded popover bubble
        this._container = new St.BoxLayout({
            vertical: true,
            style: 'background-color: rgba(30, 30, 30, 0.95); border-radius: 24px; padding: 16px; border: 1px solid rgba(255,255,255,0.1); box-shadow: 0px 10px 30px rgba(0,0,0,0.8);'
        });

        // Search Entry for Filtering
        this._searchEntry = new St.Entry({
            hint_text: 'Type to filter...',
            style_class: 'search-entry',
            style: 'border-radius: 12px; padding: 6px 12px; margin-bottom: 16px; background-color: rgba(255,255,255,0.1); color: white; width: 400px;'
        });

        this._searchEntry.clutter_text.connect('text-changed', () => {
            this._filterGrid(this._searchEntry.get_text());
        });

        this._container.add_child(this._searchEntry);

        // Flow Layout for the Grid
        const flowLayout = new Clutter.FlowLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            column_spacing: 12,
            row_spacing: 12,
            homogeneous: true
        });

        this._scrollView = new St.ScrollView({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            enable_mouse_scrolling: true,
            style: 'width: 440px; min-height: 200px; max-height: 500px;'
        });

        this._gridContainer = new St.BoxLayout({
            vertical: false,
            layout_manager: flowLayout,
            style: 'padding: 8px;'
        });

        this._scrollView.set_child(this._gridContainer);
        this._container.add_child(this._scrollView);

        this.add_child(this._container);

        // Dismiss when clicking outside
        this.connect('button-press-event', (actor, event) => {
            if (!this._container.contains(event.get_source())) {
                this.close();
            }
            return Clutter.EVENT_PROPAGATE;
        });
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

            this._container.set_position(destX, originY);
            this._container.set_opacity(0);
            this._container.set_scale(0.8, 0.8);
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

        // Construct grid widgets
        this._items.forEach((data, index) => {
            const iconWidget = new St.Icon({
                gicon: data.icon,
                icon_size: 64,
                style_class: 'stack-item-icon'
            });

            if (data.isImage) {
                iconWidget.set_style('border: 3px solid #ffffff; border-radius: 4px; background-color: #ffffff; box-shadow: 0px 4px 6px rgba(0,0,0,0.6); padding: 0;');
            } else if (data.isAction) {
                iconWidget.set_style('icon-shadow: 0px 4px 6px rgba(0,0,0,0.6);');
            } else {
                iconWidget.set_style('border-radius: 4px; icon-shadow: 0px 4px 6px rgba(0,0,0,0.6);');
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
            itemContainer.hoverTargetScale = 1.05;

            itemContainer.connect('notify::hover', () => {
                const targetScale = itemContainer.hover ? itemContainer.hoverTargetScale : 1.0;
                itemContainer.set_pivot_point(0.5, 0.5);
                itemContainer.ease({
                    scale_x: targetScale,
                    scale_y: targetScale,
                    duration: 120,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });

                // When hovered, pull focus from search bar so Spacebar doesn't type spaces into the bar
                if (itemContainer.hover) {
                    this.grab_key_focus();
                } else {
                    this._searchEntry.grab_key_focus();
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

        // Map global captured events for Spacebar to trigger GNOME Sushi
        this._keyPressId = global.stage.connect('captured-event', (actor, event) => {
            if (event.type() !== Clutter.EventType.KEY_PRESS) return Clutter.EVENT_PROPAGATE;

            // Do not intercept if actively typing in the search bar, unless it's Esc/Enter maybe
            if (global.stage.get_key_focus() === this._searchEntry.clutter_text) {
                // If they press Escape while in search, clear search or close
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

            if (event.get_key_symbol() === Clutter.KEY_space) {
                const children = this._gridContainer.get_children();
                const [mx, my] = global.get_pointer();

                for (let i = 0; i < children.length; i++) {
                    const child = children[i];

                    const [_, x, y] = child.get_transformed_position();
                    const [__, w, h] = child.get_transformed_size();
                    const isHovered = child.hover || (mx >= x && mx <= x + w && my >= y && my <= y + h);

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
            } else if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });
    }

    _filterGrid(term) {
        const lowerTerm = term.toLowerCase();
        this._renderedWidgets.forEach(widget => {
            const show = widget._data.name.toLowerCase().includes(lowerTerm);
            if (show && !widget.visible) {
                widget.show();
            } else if (!show && widget.visible) {
                widget.hide();
            }
        });
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

    constructor(folderPath) {
        super({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'dash-item-container',
            x_expand: false,
            y_expand: false
        });

        this.folderPath = folderPath;
        this.folderName = folderPath.split('/').pop() || folderPath;
        this._settings = Extension.lookupByURL(import.meta.url).getSettings('org.gnome.shell.extensions.dock-stacks');

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
                    } else {
                        // Use actual image file directly
                        const imageFile = file.get_child(info.get_name());
                        gicon = new Gio.FileIcon({ file: imageFile });
                    }
                }

                items.push({
                    name: info.get_name(),
                    icon: gicon || new Gio.ThemedIcon({ name: 'text-x-generic' }),
                    type: info.get_file_type(),
                    isImage: isImage,
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
        this._dashBox = Main.overview.dash._box; // Target dash container

        this._syncStacks();

        this._settingsChangedId = this._settings.connect('changed::configured-folders', () => {
            this._syncStacks();
        });
    }

    _syncStacks() {
        this._cleanStacks();

        const folders = this._settings.get_strv('configured-folders');
        for (const folder of folders) {
            try {
                const stackIcon = new StackIconContainer(folder);
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

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        this._cleanStacks();
        this._settings = null;
    }
}
