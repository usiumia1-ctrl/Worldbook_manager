/**
 * World Book Quick Switch (世界书快捷开关)
 *
 * A SillyTavern extension that makes the *global* World Info / Lorebook
 * activation state obvious at a glance, and lets you flip books on and off
 * (one by one, or in bulk) without fighting the multi-select control.
 */

import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { world_names, selected_world_info, loadWorldInfo, deleteWorldInfo } from '../../../world-info.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { getCurrentLocale } from '../../../i18n.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandEnumValue, enumTypes } from '../../../slash-commands/SlashCommandEnumValue.js';

const MODULE_NAME = 'worldbookQuickSwitch';
const LOG_PREFIX = '[WBQS]';

const defaultSettings = {
    /** @type {{name: string, worlds: string[]}[]} */
    presets: [],
    /** @type {{character: Object<string, string>, chat: Object<string, string>}} preset name per character avatar / per chat */
    bindings: { character: {}, chat: {} },
    onlyActive: false,
    sort: 'active',
    showEntryCount: false,
    showStateLabel: true,
    autoApplyBinding: true,
    collapsed: false,
    wandButton: true,
};

const isZh = String(getCurrentLocale() ?? '').toLowerCase().startsWith('zh');

/**
 * Tiny locale helper. The extension ships Chinese and English strings only.
 * @param {string} zh Chinese string
 * @param {string} en English string
 * @returns {string}
 */
function L(zh, en) {
    return isZh ? zh : en;
}

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const settings = extension_settings[MODULE_NAME];
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = structuredClone(value);
        }
    }
    if (!Array.isArray(settings.presets)) {
        settings.presets = [];
    }
    if (!settings.bindings || typeof settings.bindings !== 'object') {
        settings.bindings = { character: {}, chat: {} };
    }
    settings.bindings.character ??= {};
    settings.bindings.chat ??= {};
    // Hiding the native selector used to be opt-in; the panel replaces it now.
    delete settings.hideNative;
    return settings;
}

// #region World info state

/** @returns {string[]} Every known world book name, in SillyTavern's own order. */
function getAllWorlds() {
    return Array.isArray(world_names) ? world_names.slice() : [];
}

/** @returns {string[]} Names of the world books enabled globally. */
function getActiveWorlds() {
    return Array.isArray(selected_world_info) ? selected_world_info.slice() : [];
}

/**
 * Writes a new global activation state through SillyTavern's own multi-select,
 * so that core stays the single source of truth (it saves settings and emits
 * WORLDINFO_SETTINGS_UPDATED for us).
 * @param {string[]} names World book names that should end up enabled
 * @returns {boolean} Whether the change could be applied
 */
function applyActiveWorlds(names) {
    const all = getAllWorlds();
    const wanted = [...new Set(names)].filter(name => all.includes(name));
    const $select = $('#world_info');

    if (!$select.length) {
        toastr.error(L('找不到世界书选择框，插件无法切换。', 'The world info selector was not found.'), L('世界书快捷开关', 'World Book Quick Switch'));
        return false;
    }

    if (!all.length) {
        return false;
    }

    // jQuery runs the handlers synchronously, so core has already committed the
    // new state (and saved it) by the time we repaint.
    $select.val(wanted.map(name => String(all.indexOf(name)))).trigger('change');
    renderAll();
    return true;
}

/**
 * @param {string} name World book name
 * @param {boolean} [state] Target state, toggles when omitted
 */
function setWorldState(name, state) {
    const active = getActiveWorlds();
    const isOn = active.includes(name);
    const target = state === undefined ? !isOn : Boolean(state);

    if (target === isOn) {
        return;
    }

    applyActiveWorlds(target ? [...active, name] : active.filter(x => x !== name));
}

/**
 * @param {string[]} names World book names
 * @param {boolean} state Target state for all of them
 */
function setManyWorldStates(names, state) {
    const active = getActiveWorlds();
    const next = state
        ? [...active, ...names]
        : active.filter(x => !names.includes(x));

    if (next.length === active.length && next.every(x => active.includes(x))) {
        return;
    }

    applyActiveWorlds(next);
}

function invertAllWorlds() {
    const active = getActiveWorlds();
    applyActiveWorlds(getAllWorlds().filter(name => !active.includes(name)));
}

/**
 * Opens a book in the built-in world info editor.
 * @param {string} name World book name
 */
function openInEditor(name) {
    const index = getAllWorlds().indexOf(name);
    if (index === -1) {
        return;
    }
    $('#world_editor_select').val(String(index)).trigger('change');
}

// #endregion

// #region Preset bindings

/**
 * Identifies what is currently open, so a preset can be pinned to it.
 * @returns {{characterKey: string?, chatKey: string?, characterLabel: string?, chatLabel: string?}}
 */
function getBindingTargets() {
    const empty = { characterKey: null, chatKey: null, characterLabel: null, chatLabel: null };

    let context;
    try {
        context = getContext();
    } catch (error) {
        console.warn(LOG_PREFIX, 'No context available', error);
        return empty;
    }

    const chatId = context.getCurrentChatId?.();

    if (context.groupId) {
        const group = context.groups?.find(x => String(x.id) === String(context.groupId));
        return {
            characterKey: `group:${context.groupId}`,
            characterLabel: L(`群聊「${group?.name ?? context.groupId}」`, `group "${group?.name ?? context.groupId}"`),
            chatKey: chatId ? `group:${context.groupId}/${chatId}` : null,
            chatLabel: chatId ? String(chatId) : null,
        };
    }

    const character = context.characters?.[context.characterId];
    if (!character?.avatar) {
        return empty;
    }

    return {
        characterKey: `char:${character.avatar}`,
        characterLabel: character.name ?? character.avatar,
        chatKey: chatId ? `char:${character.avatar}/${chatId}` : null,
        chatLabel: chatId ? String(chatId) : null,
    };
}

/**
 * Resolves the preset bound to what is open right now. A binding on the chat
 * wins over one on the character, so a single chat can deviate.
 * @returns {{preset: {name: string, worlds: string[]}, scope: 'chat'|'character'}?}
 */
function getActiveBinding() {
    const settings = getSettings();
    const { characterKey, chatKey } = getBindingTargets();

    for (const [scope, key] of /** @type {const} */ ([['chat', chatKey], ['character', characterKey]])) {
        if (!key) {
            continue;
        }
        const presetName = settings.bindings[scope][key];
        const preset = settings.presets.find(x => x.name === presetName);
        if (preset) {
            return { preset, scope };
        }
        if (presetName) {
            // The preset was deleted or renamed - drop the dangling binding.
            delete settings.bindings[scope][key];
            saveSettingsDebounced();
        }
    }

    return null;
}

/** Applies the bound preset when switching chats, if there is one and it differs. */
function applyBindingForCurrentChat() {
    const settings = getSettings();
    if (!settings.autoApplyBinding || !getAllWorlds().length) {
        return;
    }

    const binding = getActiveBinding();
    if (!binding) {
        renderAll();
        return;
    }

    const active = getActiveWorlds();
    const wanted = binding.preset.worlds.filter(name => getAllWorlds().includes(name));
    const same = wanted.length === active.length && wanted.every(name => active.includes(name));

    if (same) {
        renderAll();
        return;
    }

    if (applyActiveWorlds(binding.preset.worlds)) {
        toastr.info(
            L(`已应用绑定方案：${binding.preset.name}`, `Applied bound preset: ${binding.preset.name}`),
            L('世界书快捷开关', 'World Book Quick Switch'),
        );
    }
}

// #endregion

// #region Entry counts

/** @type {Map<string, {total: number, disabled: number}>} */
const entryCountCache = new Map();
/** @type {Set<string>} */
const entryCountPending = new Set();

/**
 * Lazily resolves the entry count of a book. Results are cached; SillyTavern
 * caches the underlying fetch as well, so this is cheap after the first pass.
 * @param {string} name World book name
 * @returns {Promise<void>}
 */
async function ensureEntryCount(name) {
    if (entryCountCache.has(name) || entryCountPending.has(name)) {
        return;
    }

    entryCountPending.add(name);

    try {
        const data = await loadWorldInfo(name);
        const entries = Object.values(data?.entries ?? {});
        entryCountCache.set(name, {
            total: entries.length,
            disabled: entries.filter(entry => entry?.disable).length,
        });
    } catch (error) {
        console.warn(LOG_PREFIX, 'Failed to read entries of', name, error);
        entryCountCache.set(name, { total: NaN, disabled: 0 });
    } finally {
        entryCountPending.delete(name);
    }
}

/**
 * Fetches counts for the given books with a small concurrency limit, then
 * refreshes every mounted panel once they are in.
 * @param {string[]} names World book names
 */
async function loadEntryCounts(names) {
    const queue = names.filter(name => !entryCountCache.has(name) && !entryCountPending.has(name));
    if (!queue.length) {
        return;
    }

    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length) {
            await ensureEntryCount(queue.shift());
        }
    });

    await Promise.all(workers);
    renderAll();
}

// #endregion

// #region Panel

/** @type {WorldBookPanel[]} */
const panels = [];

/** Keeps multi-select ticks alive across re-renders. @type {Set<string>} */
const selection = new Set();

/** Multi-select mode. Runtime only - a reload should never start in it. */
let selectMode = false;

function pruneSelection() {
    const all = getAllWorlds();
    for (const name of [...selection]) {
        if (!all.includes(name)) {
            selection.delete(name);
        }
    }
}

/**
 * Applies search / "only active" / sorting to the full book list.
 * @param {string} search Raw search text
 * @returns {string[]} Names to display, in display order
 */
function getVisibleWorlds(search) {
    const settings = getSettings();
    const active = getActiveWorlds();
    const needle = search.trim().toLowerCase();

    let names = getAllWorlds();

    if (needle) {
        names = names.filter(name => name.toLowerCase().includes(needle));
    }

    if (settings.onlyActive) {
        names = names.filter(name => active.includes(name));
    }

    if (settings.sort === 'name') {
        names.sort((a, b) => a.localeCompare(b));
    } else if (settings.sort === 'active') {
        names.sort((a, b) => {
            const diff = Number(active.includes(b)) - Number(active.includes(a));
            return diff !== 0 ? diff : a.localeCompare(b);
        });
    }

    return names;
}

class WorldBookPanel {
    /** @param {{ standalone?: boolean }} options */
    constructor({ standalone = false } = {}) {
        this.standalone = standalone;
        this.search = '';
        /** @type {number} Index of the last checkbox clicked, for shift-range selection */
        this.lastCheckedIndex = -1;
        /** @type {string[]} Names currently rendered, in display order */
        this.rendered = [];
        /** @type {Object<string, string>} Last markup written per section, to avoid pointless DOM churn */
        this.lastHtml = {};
        /** @type {string} Preset the panel selected on its own, to tell it apart from the user's pick */
        this.autoPreset = '';

        this.root = document.createElement('div');
        this.root.classList.add('wbqs-panel');
        if (standalone) {
            this.root.classList.add('wbqs-standalone');
        }
        this.root.innerHTML = this.template();

        this.listEl = this.root.querySelector('.wbqs-list');
        this.statEl = this.root.querySelector('.wbqs-stat');
        this.searchEl = this.root.querySelector('.wbqs-search');
        this.bodyEl = this.root.querySelector('.wbqs-body');
        this.presetSelectEl = this.root.querySelector('.wbqs-preset-select');

        this.bindEvents();
    }

    template() {
        const settings = getSettings();
        return `
        <div class="wbqs-header">
            <div class="wbqs-title">
                <i class="fa-solid fa-book-atlas"></i>
                <span>${L('世界书快捷开关', 'World Book Quick Switch')}</span>
            </div>
            <div class="wbqs-stat"></div>
            <div class="wbqs-header-actions">
                <div class="wbqs-icon-btn wbqs-options-btn fa-solid fa-gear" title="${L('选项', 'Options')}"></div>
                ${this.standalone ? '' : `<div class="wbqs-icon-btn wbqs-collapse-btn fa-solid ${settings.collapsed ? 'fa-chevron-down' : 'fa-chevron-up'}" title="${L('折叠 / 展开', 'Collapse / expand')}"></div>`}
            </div>
        </div>
        <div class="wbqs-body" ${!this.standalone && settings.collapsed ? 'style="display:none"' : ''}>
            <div class="wbqs-toolbar">
                <input type="search" class="wbqs-search text_pole textarea_compact" placeholder="${L('搜索世界书…', 'Search world books…')}">
                <select class="wbqs-sort text_pole textarea_compact">
                    <option value="active">${L('已启用优先', 'Active first')}</option>
                    <option value="name">${L('按名称', 'By name')}</option>
                    <option value="original">${L('默认顺序', 'Default order')}</option>
                </select>
                <label class="wbqs-chip" title="${L('只显示已启用的世界书', 'Show only enabled books')}">
                    <input type="checkbox" class="wbqs-only-active">
                    <span>${L('只看已启用', 'Only active')}</span>
                </label>
                <div class="menu_button menu_button_icon wbqs-select-mode-btn" title="${L('多选模式：点击行改为勾选，可批量开关', 'Multi-select mode: rows get ticked instead of toggled, for bulk actions')}">
                    <i class="fa-solid fa-list-check"></i><span>${L('多选', 'Select')}</span>
                </div>
            </div>
            <div class="wbqs-options" style="display:none">
                <label class="wbqs-chip">
                    <input type="checkbox" class="wbqs-show-count">
                    <span>${L('显示条目数量', 'Show entry counts')}</span>
                </label>
                <label class="wbqs-chip">
                    <input type="checkbox" class="wbqs-wand-button">
                    <span>${L('魔杖菜单显示按钮', 'Wand menu button')}</span>
                </label>
                <label class="wbqs-chip" title="${L('每行显示「已启用 / 已关闭」文字', 'Show the ON / OFF label on every row')}">
                    <input type="checkbox" class="wbqs-show-state">
                    <span>${L('显示开关文字', 'State label')}</span>
                </label>
                <label class="wbqs-chip" title="${L('切换角色卡或聊天时，自动应用绑定的方案', 'Apply the bound preset when the character or chat changes')}">
                    <input type="checkbox" class="wbqs-auto-bind">
                    <span>${L('自动应用绑定方案', 'Auto-apply bindings')}</span>
                </label>
            </div>
            <div class="wbqs-bulk">
                <div class="menu_button menu_button_icon wbqs-bulk-btn" data-action="all-on" title="${L('开启当前列表中显示的全部世界书', 'Enable every book currently listed')}">
                    <i class="fa-solid fa-toggle-on"></i><span>${L('全部开', 'All on')}</span>
                </div>
                <div class="menu_button menu_button_icon wbqs-bulk-btn" data-action="all-off" title="${L('关闭当前列表中显示的全部世界书', 'Disable every book currently listed')}">
                    <i class="fa-solid fa-toggle-off"></i><span>${L('全部关', 'All off')}</span>
                </div>
                <div class="menu_button menu_button_icon wbqs-bulk-btn" data-action="invert" title="${L('反转所有世界书的开关状态（不受筛选影响）', 'Invert every book, ignoring filters')}">
                    <i class="fa-solid fa-right-left"></i><span>${L('反转', 'Invert')}</span>
                </div>
            </div>
            <div class="wbqs-selbar" style="display:none">
                <div class="menu_button menu_button_icon wbqs-bulk-btn" data-action="sel-all">
                    <i class="fa-solid fa-check-double"></i><span>${L('全选', 'Select all')}</span>
                </div>
                <div class="menu_button menu_button_icon wbqs-bulk-btn wbqs-needs-selection" data-action="sel-on">
                    <i class="fa-solid fa-toggle-on"></i><span>${L('开启选中', 'Enable checked')}</span>
                </div>
                <div class="menu_button menu_button_icon wbqs-bulk-btn wbqs-needs-selection" data-action="sel-off">
                    <i class="fa-solid fa-toggle-off"></i><span>${L('关闭选中', 'Disable checked')}</span>
                </div>
                <div class="menu_button menu_button_icon wbqs-bulk-btn wbqs-needs-selection" data-action="sel-clear">
                    <i class="fa-solid fa-eraser"></i><span>${L('清除勾选', 'Clear checks')}</span>
                </div>
                <div class="wbqs-spacer"></div>
                <div class="menu_button menu_button_icon wbqs-bulk-btn wbqs-needs-selection wbqs-danger" data-action="sel-delete" title="${L('把勾选的世界书从酒馆里彻底删除', 'Permanently delete the ticked world books')}">
                    <i class="fa-solid fa-trash-can"></i><span>${L('删除选中', 'Delete checked')}</span>
                </div>
            </div>
            <div class="wbqs-list"></div>
            <div class="wbqs-binding" style="display:none"></div>
            <div class="wbqs-presets">
                <span class="wbqs-presets-label">${L('方案', 'Presets')}</span>
                <select class="wbqs-preset-select text_pole textarea_compact"></select>
                <div class="menu_button menu_button_icon wbqs-preset-btn" data-action="apply" title="${L('用该方案覆盖当前启用状态', 'Replace the current activation with this preset')}">
                    <i class="fa-solid fa-play"></i><span>${L('应用', 'Apply')}</span>
                </div>
                <div class="menu_button menu_button_icon wbqs-preset-btn" data-action="create" title="${L('把当前启用的世界书存成一个新方案', 'Save the currently enabled books as a new preset')}">
                    <i class="fa-solid fa-plus"></i><span>${L('新建', 'New')}</span>
                </div>
                <div class="menu_button menu_button_icon wbqs-preset-btn" data-action="save" title="${L('用当前启用状态覆盖所选方案', 'Overwrite the selected preset with the current activation')}">
                    <i class="fa-solid fa-floppy-disk"></i><span>${L('保存', 'Save')}</span>
                </div>
                <div class="menu_button menu_button_icon wbqs-preset-btn" data-action="bind" title="${L('把方案绑定到当前角色卡或当前聊天', 'Bind this preset to the current character or chat')}">
                    <i class="fa-solid fa-link"></i><span>${L('绑定', 'Bind')}</span>
                </div>
                <div class="menu_button menu_button_icon wbqs-preset-btn" data-action="delete" title="${L('删除方案', 'Delete preset')}">
                    <i class="fa-solid fa-trash-can"></i>
                </div>
            </div>
        </div>`;
    }

    bindEvents() {
        const settings = getSettings();
        const $root = $(this.root);

        $root.on('input', '.wbqs-search', event => {
            this.search = String($(event.currentTarget).val() ?? '');
            this.renderList();
        });

        $root.on('change', '.wbqs-sort', event => {
            settings.sort = String($(event.currentTarget).val());
            saveSettingsDebounced();
            renderAll();
        });

        $root.on('change', '.wbqs-only-active', event => {
            settings.onlyActive = event.currentTarget.checked;
            saveSettingsDebounced();
            renderAll();
        });

        $root.on('change', '.wbqs-show-count', event => {
            settings.showEntryCount = event.currentTarget.checked;
            saveSettingsDebounced();
            renderAll();
        });

        $root.on('change', '.wbqs-wand-button', event => {
            settings.wandButton = event.currentTarget.checked;
            saveSettingsDebounced();
            updateWandButton();
            renderAll();
        });

        $root.on('change', '.wbqs-show-state', event => {
            settings.showStateLabel = event.currentTarget.checked;
            saveSettingsDebounced();
            renderAll();
        });

        $root.on('change', '.wbqs-auto-bind', event => {
            settings.autoApplyBinding = event.currentTarget.checked;
            saveSettingsDebounced();
            renderAll();
        });

        $root.on('click', '.wbqs-select-mode-btn', () => {
            selectMode = !selectMode;
            if (!selectMode) {
                selection.clear();
            }
            renderAll();
        });

        $root.on('click', '.wbqs-options-btn', () => {
            const options = this.root.querySelector('.wbqs-options');
            options.style.display = options.style.display === 'none' ? '' : 'none';
        });

        // The whole title bar folds the panel - it is the biggest target in the
        // header, and the gear is the only thing in there that does its own job.
        $root.on('click', '.wbqs-header', event => {
            if (this.standalone || /** @type {HTMLElement} */ (event.target).closest('.wbqs-options-btn')) {
                return;
            }

            settings.collapsed = !settings.collapsed;
            saveSettingsDebounced();
            this.applyCollapsed();
        });

        $root.on('click', '.wbqs-bulk-btn', event => {
            const action = String($(event.currentTarget).data('action'));
            const visible = this.rendered;
            const checked = [...selection];

            switch (action) {
                case 'all-on':
                    setManyWorldStates(visible, true);
                    break;
                case 'all-off':
                    setManyWorldStates(visible, false);
                    break;
                case 'invert':
                    invertAllWorlds();
                    break;
                case 'sel-all':
                    visible.forEach(name => selection.add(name));
                    renderAll();
                    break;
                case 'sel-on':
                    setManyWorldStates(checked, true);
                    break;
                case 'sel-off':
                    setManyWorldStates(checked, false);
                    break;
                case 'sel-clear':
                    selection.clear();
                    renderAll();
                    break;
                case 'sel-delete':
                    this.deleteCheckedWorlds(checked);
                    break;
            }
        });

        $root.on('click', '.wbqs-preset-btn', event => this.onPresetAction(String($(event.currentTarget).data('action'))));

        // Row interactions. In select mode a row click picks the row for a bulk
        // action; otherwise it flips the book. One meaning at a time, so the row
        // never shows two competing states.
        $root.on('click', '.wbqs-item', event => {
            const target = /** @type {HTMLElement} */ (event.target);
            if (target.closest('.wbqs-open')) {
                return;
            }

            const name = String(event.currentTarget.dataset.name);

            if (!selectMode) {
                setWorldState(name);
                return;
            }

            const index = this.rendered.indexOf(name);
            const picked = !selection.has(name);

            if (/** @type {MouseEvent} */ (event.originalEvent)?.shiftKey && this.lastCheckedIndex >= 0 && index >= 0) {
                const [from, to] = [this.lastCheckedIndex, index].sort((a, b) => a - b);
                for (const rangeName of this.rendered.slice(from, to + 1)) {
                    picked ? selection.add(rangeName) : selection.delete(rangeName);
                }
            } else {
                picked ? selection.add(name) : selection.delete(name);
            }

            this.lastCheckedIndex = index;
            renderAll();
        });

        $root.on('click', '.wbqs-open', event => {
            event.stopPropagation();
            const name = String(event.currentTarget.closest('.wbqs-item').dataset.name);
            openInEditor(name);
            if (this.standalone) {
                $('#WIDrawerIcon:not(.openIcon)').trigger('click');
            }
        });

        $root.on('click', '.wbqs-binding-clear', () => this.unbindCurrent());
    }

    onPresetAction(action) {
        const settings = getSettings();
        const name = String($(this.presetSelectEl).val() ?? '');
        const preset = settings.presets.find(x => x.name === name);

        switch (action) {
            case 'apply':
                if (!preset) {
                    return toastr.info(L('请先选择一个方案。', 'Pick a preset first.'));
                }
                applyActiveWorlds(preset.worlds);
                toastr.success(L(`已应用方案：${preset.name}`, `Applied preset: ${preset.name}`));
                break;
            case 'create':
                this.createPreset();
                break;
            case 'save':
                if (!preset) {
                    return toastr.info(L('请先在左边选择要覆盖的方案，或点「新建」。', 'Pick the preset to overwrite first, or hit New.'));
                }
                this.overwritePreset(preset);
                break;
            case 'bind':
                if (!preset) {
                    return toastr.info(L('请先选择一个方案。', 'Pick a preset first.'));
                }
                this.bindPreset(preset);
                break;
            case 'delete':
                this.deletePreset(preset);
                break;
        }
    }

    /**
     * Pins a preset to the open character or the open chat.
     * @param {{name: string, worlds: string[]}} preset
     */
    async bindPreset(preset) {
        const settings = getSettings();
        const targets = getBindingTargets();

        if (!targets.characterKey) {
            return toastr.info(L('请先打开一个角色卡或群聊。', 'Open a character or group chat first.'));
        }

        const current = getActiveBinding();
        const content = document.createElement('div');
        content.classList.add('wbqs-bind-popup');
        content.innerHTML = `
            <h3>${L('绑定方案', 'Bind preset')}</h3>
            <p>${L(`把方案「${escapeHtml(preset.name)}」（${preset.worlds.length} 本世界书）绑定到：`, `Bind the preset "${escapeHtml(preset.name)}" (${preset.worlds.length} books) to:`)}</p>
            <ul>
                <li><b>${L('角色卡', 'Character')}</b>：${escapeHtml(targets.characterLabel ?? '-')}</li>
                <li><b>${L('当前聊天', 'This chat')}</b>：${escapeHtml(targets.chatLabel ?? L('（无）', '(none)'))}</li>
            </ul>
            <p class="wbqs-bind-note">${current
        ? L(`当前生效的绑定：${escapeHtml(current.preset.name)}（${current.scope === 'chat' ? '聊天' : '角色卡'}级）`,
            `Currently bound: ${escapeHtml(current.preset.name)} (${current.scope} level)`)
        : L('当前没有绑定。', 'Nothing is bound right now.')}</p>
            <p class="wbqs-bind-note">${L('聊天级绑定优先于角色卡级绑定。', 'A chat binding takes priority over a character binding.')}</p>`;

        const result = await new Popup(content, POPUP_TYPE.TEXT, '', {
            okButton: L('取消', 'Cancel'),
            customButtons: [
                { text: L('绑定到角色卡', 'Bind to character'), result: POPUP_RESULT.CUSTOM1, icon: 'fa-user' },
                ...(targets.chatKey ? [{ text: L('绑定到当前聊天', 'Bind to this chat'), result: POPUP_RESULT.CUSTOM2, icon: 'fa-comments' }] : []),
                ...(current ? [{ text: L('解除绑定', 'Unbind'), result: POPUP_RESULT.CUSTOM3, icon: 'fa-link-slash' }] : []),
            ],
        }).show();

        if (result === POPUP_RESULT.CUSTOM1) {
            settings.bindings.character[targets.characterKey] = preset.name;
            toastr.success(L(`已绑定到角色卡：${targets.characterLabel}`, `Bound to character: ${targets.characterLabel}`));
        } else if (result === POPUP_RESULT.CUSTOM2) {
            settings.bindings.chat[targets.chatKey] = preset.name;
            toastr.success(L('已绑定到当前聊天。', 'Bound to this chat.'));
        } else if (result === POPUP_RESULT.CUSTOM3) {
            this.unbindCurrent();
            return;
        } else {
            return;
        }

        saveSettingsDebounced();
        renderAll();
    }

    /** Removes whichever binding applies to the open chat / character. */
    unbindCurrent() {
        const settings = getSettings();
        const targets = getBindingTargets();
        let removed = false;

        if (targets.chatKey && settings.bindings.chat[targets.chatKey]) {
            delete settings.bindings.chat[targets.chatKey];
            removed = true;
        } else if (targets.characterKey && settings.bindings.character[targets.characterKey]) {
            delete settings.bindings.character[targets.characterKey];
            removed = true;
        }

        if (removed) {
            saveSettingsDebounced();
            renderAll();
            toastr.success(L('已解除绑定。', 'Binding removed.'));
        }
    }

    /**
     * Deletes the ticked world books from SillyTavern for good. This throws
     * files away, so it asks first and spells out exactly what goes.
     * @param {string[]} names World book names
     */
    async deleteCheckedWorlds(names) {
        const targets = names.filter(name => getAllWorlds().includes(name));

        if (!targets.length) {
            return;
        }

        const shown = targets.slice(0, 12);
        const rest = targets.length - shown.length;
        const content = document.createElement('div');
        content.classList.add('wbqs-bind-popup');
        content.innerHTML = `
            <h3>${L('删除世界书', 'Delete world books')}</h3>
            <p>${L(`确定要<b>彻底删除</b>这 ${targets.length} 本世界书吗？`, `Permanently delete these ${targets.length} world books?`)}</p>
            <ul>${shown.map(name => `<li>${escapeHtml(name)}</li>`).join('')}</ul>
            ${rest > 0 ? `<p class="wbqs-bind-note">${L(`……以及另外 ${rest} 本。`, `…and ${rest} more.`)}</p>` : ''}
            <p class="wbqs-bind-note wbqs-warning">${L('文件会从酒馆里删掉，无法撤销。', 'The files are removed from SillyTavern. This cannot be undone.')}</p>`;

        const confirmed = await new Popup(content, POPUP_TYPE.CONFIRM, '', {
            okButton: L(`删除 ${targets.length} 本`, `Delete ${targets.length}`),
            cancelButton: L('取消', 'Cancel'),
        }).show();

        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        let deleted = 0;
        const failed = [];

        for (const name of targets) {
            try {
                await deleteWorldInfo(name) ? deleted++ : failed.push(name);
            } catch (error) {
                console.error(LOG_PREFIX, 'Failed to delete', name, error);
                failed.push(name);
            }
            selection.delete(name);
        }

        renderAll();

        if (deleted) {
            toastr.success(L(`已删除 ${deleted} 本世界书。`, `Deleted ${deleted} world books.`));
        }
        if (failed.length) {
            toastr.error(L(`有 ${failed.length} 本没能删除：${failed.join('、')}`, `Could not delete ${failed.length}: ${failed.join(', ')}`));
        }
    }

    /** Stores the current activation under a brand new name. */
    async createPreset() {
        const settings = getSettings();
        const active = getActiveWorlds();
        const name = (await Popup.show.input(
            L('新建方案', 'New preset'),
            L(`把当前启用的 ${active.length} 本世界书存成新方案，取个名字：`, `Save the ${active.length} currently enabled books as a new preset. Name it:`),
            '',
        ))?.trim();

        if (!name) {
            return;
        }

        const existing = settings.presets.find(x => x.name === name);
        if (existing) {
            const confirmed = await Popup.show.confirm(
                L('同名方案已存在', 'That name is taken'),
                L(`已经有一个叫「${name}」的方案（${existing.worlds.length} 本），要覆盖它吗？`, `A preset called "${name}" already exists (${existing.worlds.length} books). Overwrite it?`),
            );

            if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
                return;
            }

            existing.worlds = active;
        } else {
            settings.presets.push({ name, worlds: active });
        }

        saveSettingsDebounced();
        renderAll();
        $(this.presetSelectEl).val(name);
        toastr.success(L(`已新建方案：${name}（${active.length} 本）`, `Preset created: ${name} (${active.length} books)`));
    }

    /**
     * Overwrites an existing preset with whatever is enabled right now.
     * @param {{name: string, worlds: string[]}} preset
     */
    overwritePreset(preset) {
        const active = getActiveWorlds();
        preset.worlds = active;
        saveSettingsDebounced();
        renderAll();
        toastr.success(L(`已更新方案「${preset.name}」：${active.length} 本世界书`, `Updated preset "${preset.name}": ${active.length} books`));
    }

    async deletePreset(preset) {
        if (!preset) {
            return toastr.info(L('请先选择一个方案。', 'Pick a preset first.'));
        }

        const settings = getSettings();
        const confirmed = await Popup.show.confirm(
            L('删除方案', 'Delete preset'),
            L(`确定删除方案「${preset.name}」吗？`, `Delete the preset "${preset.name}"?`),
        );

        if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        settings.presets = settings.presets.filter(x => x !== preset);
        saveSettingsDebounced();
        renderAll();
    }

    render() {
        const settings = getSettings();

        $(this.root).find('.wbqs-sort').val(settings.sort);
        $(this.root).find('.wbqs-only-active').prop('checked', settings.onlyActive);
        $(this.root).find('.wbqs-show-count').prop('checked', settings.showEntryCount);
        $(this.root).find('.wbqs-wand-button').prop('checked', settings.wandButton);
        $(this.root).find('.wbqs-show-state').prop('checked', settings.showStateLabel);
        $(this.root).find('.wbqs-auto-bind').prop('checked', settings.autoApplyBinding);

        if (String($(this.searchEl).val() ?? '') !== this.search) {
            $(this.searchEl).val(this.search);
        }

        this.applyCollapsed();
        this.renderStat();
        this.renderBinding();
        this.renderPresets();
        this.renderList();
    }

    renderBinding() {
        const element = this.root.querySelector('.wbqs-binding');
        const binding = getActiveBinding();
        const targets = getBindingTargets();

        $(element).toggle(Boolean(binding));

        if (!binding) {
            return;
        }

        const scopeLabel = binding.scope === 'chat'
            ? L('当前聊天', 'this chat')
            : L(`角色卡「${targets.characterLabel}」`, `character "${targets.characterLabel}"`);

        this.setHtml('binding', element, `
            <i class="fa-solid fa-link"></i>
            <span>${L(`${escapeHtml(scopeLabel)} 已绑定方案 <b>${escapeHtml(binding.preset.name)}</b>`, `<b>${escapeHtml(binding.preset.name)}</b> is bound to ${escapeHtml(scopeLabel)}`)}</span>
            <div class="wbqs-binding-clear fa-solid fa-link-slash" title="${L('解除绑定', 'Remove binding')}"></div>`);
    }

    /**
     * Replaces the markup of a section only when it actually changed. Blindly
     * rewriting innerHTML on every event would swallow clicks and drop focus.
     * @param {string} key Section key
     * @param {HTMLElement} element Target element
     * @param {string} html New markup
     */
    setHtml(key, element, html) {
        if (this.lastHtml[key] === html) {
            return false;
        }
        element.innerHTML = html;
        this.lastHtml[key] = html;
        return true;
    }

    /** Syncs the folded state onto the DOM (chevron, body, header affordance). */
    applyCollapsed() {
        if (this.standalone) {
            return;
        }

        const collapsed = getSettings().collapsed;
        $(this.root).find('.wbqs-collapse-btn')
            .toggleClass('fa-chevron-up', !collapsed)
            .toggleClass('fa-chevron-down', collapsed);
        $(this.bodyEl).toggle(!collapsed);
        this.root.classList.toggle('wbqs-collapsed', collapsed);
    }

    renderStat() {
        const total = getAllWorlds().length;
        const active = getActiveWorlds().length;
        this.setHtml('stat', this.statEl, `
            <span class="wbqs-stat-active">${active}</span>
            <span class="wbqs-stat-sep">/</span>
            <span class="wbqs-stat-total">${total}</span>
            <span class="wbqs-stat-label">${L('已启用', 'active')}</span>`);
        this.statEl.classList.toggle('wbqs-stat-none', active === 0);
    }

    renderPresets() {
        const settings = getSettings();
        const current = String($(this.presetSelectEl).val() ?? '');
        const options = [`<option value="">${L('— 选择方案 —', '— Pick a preset —')}</option>`];

        for (const preset of settings.presets) {
            const label = `${preset.name} (${preset.worlds.length})`;
            options.push(`<option value="${escapeHtml(preset.name)}">${escapeHtml(label)}</option>`);
        }

        this.setHtml('presets', this.presetSelectEl, options.join(''));

        // Keep whatever the user picked, but when they have not picked anything
        // themselves, follow the preset bound to the open character or chat -
        // including after switching to a different one.
        const bound = getActiveBinding()?.preset?.name ?? '';
        const userPicked = settings.presets.some(x => x.name === current) && current !== this.autoPreset;
        const wanted = userPicked ? current : bound;

        if (!userPicked) {
            this.autoPreset = bound;
        }

        if (wanted !== current) {
            $(this.presetSelectEl).val(wanted);
        }
    }

    renderList() {
        const settings = getSettings();
        const active = getActiveWorlds();
        const names = getVisibleWorlds(this.search);
        this.rendered = names;

        $(this.root).toggleClass('wbqs-select-mode', selectMode);
        $(this.root).find('.wbqs-select-mode-btn').toggleClass('wbqs-active', selectMode);
        $(this.root).find('.wbqs-selbar').toggle(selectMode);
        $(this.root).find('.wbqs-needs-selection').toggleClass('wbqs-disabled', selection.size === 0);
        $(this.root).find('[data-action="sel-on"] span').text(L(`开启选中 (${selection.size})`, `Enable checked (${selection.size})`));
        $(this.root).find('[data-action="sel-off"] span').text(L(`关闭选中 (${selection.size})`, `Disable checked (${selection.size})`));

        if (!getAllWorlds().length) {
            this.setHtml('list', this.listEl, `<div class="wbqs-empty">${L('还没有世界书。', 'No world books yet.')}</div>`);
            return;
        }

        if (!names.length) {
            this.setHtml('list', this.listEl, `<div class="wbqs-empty">${L('没有匹配的世界书。', 'Nothing matches the current filter.')}</div>`);
            return;
        }

        const html = names.map(name => {
            const isOn = active.includes(name);
            const isChecked = selection.has(name);
            const counts = entryCountCache.get(name);
            const countText = settings.showEntryCount
                ? (counts
                    ? (Number.isNaN(counts.total)
                        ? L('读取失败', 'unreadable')
                        : L(
                            `${counts.total} 条目${counts.disabled ? `（${counts.disabled} 已禁用）` : ''}`,
                            `${counts.total} ${counts.total === 1 ? 'entry' : 'entries'}${counts.disabled ? ` (${counts.disabled} disabled)` : ''}`,
                        ))
                    : L('读取中…', 'loading…'))
                : '';

            return `
            <div class="wbqs-item ${isOn ? 'wbqs-on' : 'wbqs-off'}${isChecked ? ' wbqs-picked' : ''}" data-name="${escapeHtml(name)}" title="${escapeHtml(name)}">
                ${selectMode ? `<div class="wbqs-tick fa-solid ${isChecked ? 'fa-square-check' : 'fa-square'}"></div>` : ''}
                <div class="wbqs-info">
                    <div class="wbqs-name">${escapeHtml(name)}</div>
                    ${countText ? `<div class="wbqs-sub">${escapeHtml(countText)}</div>` : ''}
                </div>
                ${settings.showStateLabel ? `<div class="wbqs-state">${isOn ? L('已启用', 'ON') : L('已关闭', 'OFF')}</div>` : ''}
                <div class="wbqs-toggle" role="switch" aria-checked="${isOn}"><span class="wbqs-knob"></span></div>
                <div class="wbqs-open fa-solid fa-pen-to-square" title="${L('在编辑器中打开', 'Open in editor')}"></div>
            </div>`;
        }).join('');

        this.setHtml('list', this.listEl, html);

        if (settings.showEntryCount) {
            loadEntryCounts(names);
        }
    }
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
    })[char]);
}

/** Coalesces the render calls that come from chatty core events. */
let renderTimer = null;
function renderAllDebounced() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => renderAll(), 100);
}

function renderAll() {
    clearTimeout(renderTimer);
    pruneSelection();
    for (const panel of panels) {
        try {
            panel.render();
        } catch (error) {
            console.error(LOG_PREFIX, 'Render failed', error);
        }
    }
}

// #endregion

// #region Mounting

function mountDrawerPanel() {
    const holder = document.getElementById('wi-holder');
    if (!holder || document.querySelector('#wi-holder > .wbqs-panel')) {
        return;
    }

    const panel = new WorldBookPanel();
    holder.prepend(panel.root);
    panels.push(panel);
    panel.render();
}

async function showPopupPanel() {
    const panel = new WorldBookPanel({ standalone: true });
    panels.push(panel);
    panel.render();

    try {
        await new Popup(panel.root, POPUP_TYPE.TEXT, '', {
            okButton: L('关闭', 'Close'),
            wide: true,
            large: true,
            allowVerticalScrolling: true,
        }).show();
    } finally {
        const index = panels.indexOf(panel);
        if (index !== -1) {
            panels.splice(index, 1);
        }
    }
}

/**
 * Folds away the built-in multi-select: the panel replaces it, and the select
 * keeps doing its job as the state holder while hidden.
 *
 * Deliberately driven from JS rather than from the stylesheet alone, and only
 * once a panel is actually mounted - if the extension ever fails to come up,
 * the native control is still there.
 */
function takeOverNativeSelector() {
    if (!panels.length) {
        return;
    }

    const block = document.getElementById('WIMultiSelector')
        ?? document.getElementById('world_info')?.closest('.range-block');

    block?.classList.add('wbqs-hidden-native');
}

function updateWandButton() {
    const settings = getSettings();
    const menu = document.getElementById('extensionsMenu');
    const existing = document.getElementById('wbqs_wand_button');

    if (!settings.wandButton) {
        existing?.remove();
        return;
    }

    if (!menu || existing) {
        return;
    }

    const button = document.createElement('div');
    button.id = 'wbqs_wand_button';
    button.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
    button.tabIndex = 0;
    button.innerHTML = `
        <div class="fa-solid fa-book-atlas extensionsMenuExtensionButton"></div>
        <span>${L('世界书快捷开关', 'World Book Quick Switch')}</span>`;
    button.addEventListener('click', () => showPopupPanel());
    menu.append(button);
}

// #endregion

// #region Slash commands

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wb-preset',
        helpString: L(
            '应用一个「世界书快捷开关」方案。默认覆盖当前启用的全局世界书，<code>mode=append</code> 则是在现有基础上追加。',
            'Applies a World Book Quick Switch preset. Replaces the enabled global world books by default; <code>mode=append</code> adds them on top instead.',
        ),
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'mode',
                description: L('replace＝覆盖（默认），append＝追加', 'replace (default) or append'),
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'replace',
                enumList: ['replace', 'append'],
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: L('方案名称', 'Preset name'),
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
                enumProvider: () => getSettings().presets.map(preset => new SlashCommandEnumValue(
                    preset.name,
                    L(`${preset.worlds.length} 本世界书`, `${preset.worlds.length} world books`),
                    enumTypes.enum,
                )),
            }),
        ],
        callback: (args, value) => {
            const name = String(value).trim();
            const preset = getSettings().presets.find(x => x.name === name);

            if (!preset) {
                toastr.error(L(`找不到方案：${name}`, `No such preset: ${name}`));
                return '';
            }

            if (String(args.mode).toLowerCase() === 'append') {
                setManyWorldStates(preset.worlds, true);
            } else {
                applyActiveWorlds(preset.worlds);
            }

            return getActiveWorlds().join(',');
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wb-active',
        helpString: L(
            '返回当前已启用的全局世界书名称，用逗号分隔。',
            'Returns the names of the currently enabled global world books, comma separated.',
        ),
        callback: () => getActiveWorlds().join(','),
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wb-bound',
        helpString: L(
            '返回绑定到当前角色卡 / 聊天的方案名（没有则返回空）。',
            'Returns the name of the preset bound to the current character or chat, if any.',
        ),
        callback: () => getActiveBinding()?.preset.name ?? '',
    }));
}

// #endregion

function init() {
    getSettings();
    mountDrawerPanel();
    updateWandButton();
    takeOverNativeSelector();

    try {
        registerSlashCommands();
    } catch (error) {
        console.warn(LOG_PREFIX, 'Slash command registration failed', error);
    }

    for (const eventType of [event_types.WORLDINFO_SETTINGS_UPDATED, event_types.WORLDINFO_UPDATED, event_types.SETTINGS_UPDATED]) {
        if (!eventType) {
            continue;
        }
        eventSource.on(eventType, () => {
            if (eventType === event_types.WORLDINFO_UPDATED) {
                entryCountCache.clear();
            }
            renderAllDebounced();
        });
    }

    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            // The world list may still be loading right after a chat switch.
            setTimeout(() => applyBindingForCurrentChat(), 200);
        });
    }

    // The world list and the wand menu are both built during startup, and an
    // extension can be loaded before either of them exists. Keep an eye on them
    // for a short while instead of assuming a load order.
    let retries = 30;
    const timer = setInterval(() => {
        mountDrawerPanel();
        updateWandButton();
        takeOverNativeSelector();
        renderAll();

        const wandDone = !getSettings().wandButton || document.getElementById('wbqs_wand_button');
        if (--retries <= 0 || (getAllWorlds().length && panels.length && wandDone)) {
            clearInterval(timer);
        }
    }, 500);

    console.log(LOG_PREFIX, 'World Book Quick Switch loaded');
}

jQuery(() => init());
