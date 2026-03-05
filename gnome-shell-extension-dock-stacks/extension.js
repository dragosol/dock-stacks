import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Dash from 'resource:///org/gnome/shell/ui/dash.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

class StackIconContainer extends St.Widget {
    static {
        GObject.registerClass(this);
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
        });

        this.button.connect('clicked', () => {
            Main.notify(`Clicked Stack: ${this.folderName}`);
        });
    }

    _syncLabel() {
        if (this.button.hover) {
            this._label.show();
            // Small timeout to allow size allocation
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (!this.button || !this.button.hover || !this._label) return GLib.SOURCE_REMOVE;

                const [x, y] = this.button.get_transformed_position();
                const [w, h] = this.button.get_transformed_size();

                // Dash labels are styled with absolute offsets. Position centered above button
                this._label.set_position(
                    x + Math.floor((w - this._label.width) / 2),
                    y - this._label.height - 4
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
