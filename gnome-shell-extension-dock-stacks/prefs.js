import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

class StringObject extends GObject.Object {
    static {
        GObject.registerClass({
            Properties: {
                'string': GObject.ParamSpec.string(
                    'string', 'String', 'String value',
                    GObject.ParamFlags.READWRITE,
                    ''
                )
            }
        }, this);
    }
    constructor(str) {
        super({ string: str });
    }
}

export default class DockStacksPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.dock-stacks');

        const page = new Adw.PreferencesPage();

        // Behavior Group
        const behaviorGroup = new Adw.PreferencesGroup({
            title: _('Behavior')
        });
        page.add(behaviorGroup);

        // Grid mode
        const gridModeModel = new Gio.ListStore({ item_type: StringObject });
        gridModeModel.append(new StringObject('auto'));
        gridModeModel.append(new StringObject('always'));
        gridModeModel.append(new StringObject('never'));

        const gridModeRow = new Adw.ComboRow({
            title: _('Grid Layout Mode'),
            subtitle: _('When to show grid instead of fan'),
            model: gridModeModel
        });

        let initialGridMode = settings.get_string('grid-mode');
        let initialIndex = 0;
        if (initialGridMode === 'always') initialIndex = 1;
        if (initialGridMode === 'never') initialIndex = 2;
        gridModeRow.set_selected(initialIndex);

        gridModeRow.connect('notify::selected', () => {
            const selected = gridModeRow.get_selected();
            let val = 'auto';
            if (selected === 1) val = 'always';
            if (selected === 2) val = 'never';
            settings.set_string('grid-mode', val);
        });

        behaviorGroup.add(gridModeRow);

        // Fan threshold
        const thresholdRow = new Adw.SpinRow({
            title: _('Fan Threshold'),
            subtitle: _('Maximum items for fan view'),
            adjustment: new Gtk.Adjustment({
                lower: 8,
                upper: 20,
                step_increment: 1,
                value: settings.get_int('fan-threshold')
            })
        });
        settings.bind('fan-threshold', thresholdRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        behaviorGroup.add(thresholdRow);

        // Folders Group
        const foldersGroup = new Adw.PreferencesGroup({
            title: _('Pinned Folders'),
            description: _('Folders that will always appear as stacks on the dock.')
        });
        page.add(foldersGroup);

        const folderListModel = new Gio.ListStore({ item_type: StringObject });
        // Initialize list
        let configuredFolders = settings.get_strv('configured-folders');
        for (let folder of configuredFolders) {
            folderListModel.append(new StringObject(folder));
        }

        const foldersList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list']
        });
        foldersList.bind_model(folderListModel, (item) => {
            const folderPath = item.string;
            const row = new Adw.ActionRow({
                title: folderPath.split('/').pop() || folderPath,
                subtitle: folderPath
            });
            const removeBtn = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat', 'destructive-action']
            });
            removeBtn.connect('clicked', () => {
                let current = settings.get_strv('configured-folders');
                const idx = current.indexOf(folderPath);
                if (idx > -1) {
                    current.splice(idx, 1);
                    settings.set_strv('configured-folders', current);
                    // rebuild model
                    folderListModel.remove_all();
                    for (let f of current) {
                        folderListModel.append(new StringObject(f));
                    }
                }
            });
            row.add_suffix(removeBtn);
            return row;
        });
        foldersGroup.add(foldersList);

        const addFolderBtnRow = new Adw.ActionRow({
            title: _('Add Folder...'),
            activatable: true
        });
        const addIcon = new Gtk.Image({ icon_name: 'list-add-symbolic' });
        addFolderBtnRow.add_prefix(addIcon);

        addFolderBtnRow.connect('activated', () => {
            const dialog = new Gtk.FileChooserNative({
                title: _('Select Folder to Pin'),
                action: Gtk.FileChooserAction.SELECT_FOLDER,
                accept_label: _('Add'),
                cancel_label: _('Cancel'),
                transient_for: window
            });

            dialog.connect('response', (d, response_id) => {
                if (response_id === Gtk.ResponseType.ACCEPT) {
                    const file = dialog.get_file();
                    if (file) {
                        const path = file.get_path();
                        let current = settings.get_strv('configured-folders');
                        if (!current.includes(path)) {
                            current.push(path);
                            settings.set_strv('configured-folders', current);
                            folderListModel.append(new StringObject(path));
                        }
                    }
                }
                dialog.destroy();
            });
            dialog.show();
        });
        foldersGroup.add(addFolderBtnRow);

        // Safety Group
        const panicGroup = new Adw.PreferencesGroup({
            title: _('Safety')
        });
        page.add(panicGroup);

        const panicRow = new Adw.ActionRow({
            title: _('Reset to Safe State'),
            subtitle: _('Force remove all modified elements and reload defaults')
        });
        const panicButton = new Gtk.Button({
            child: new Adw.ButtonContent({
                label: _('Troubleshoot Reset'),
            }),
            css_classes: ['destructive-action']
        });
        panicRow.add_suffix(panicButton);
        panicGroup.add(panicRow);

        window.add(page);
    }
}
