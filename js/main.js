/// <reference path="../../index.d.ts" />

document.addEventListener('DOMContentLoaded', function () {
    'use strict';

    // ==========================================================================
    // Config / constants
    // ==========================================================================
    var PLAYLISTS_KEY = 'iptv_playlists';
    var ACTIVE_PLAYLISTS_KEY = 'iptv_active_playlist_id';
    var FAVORITES_KEY = 'iptv_favorites';
    var OVERLAY_HIDE_MS = 5000;
    var TOAST_MS = 3000;
    var FETCH_TIMEOUT_MS = 15000;
    var PLAYBACK_TIMEOUT_MS = 20000;
    var DVR_REFRESH_MS = 5000;
    var SEEK_STEPS_MS = [10000, 30000, 60000, 300000];
    var SEEK_STEP_LABELS = ['10 seconds', '30 seconds', '1 minute', '5 minutes'];

    // Bundled locally (playlists/index.country.m3u) rather than fetched from
    // iptv-org.github.io at runtime — the channel list then works even when
    // the device/simulator has no route to that host. Individual channel
    // streams still play from their own (live, external) servers, same as
    // any playlist.
    var DEFAULT_PLAYLIST = { id: 'default', name: 'IPTV-ORG Countries', url: 'playlists/index.country.m3u' };

    var IPTV_ORG_URL = 'https://iptv-org.github.io/iptv/index.country.m3u';

    // Custom D-pad keyboard (not the Tizen IME). Query-string characters
    // (?&=%) must sit on this always-visible punctuation row — IPTV playlist
    // URLs almost always look like .../get.php?username=...&password=...
    var KEYBOARD_ROWS = [
        ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
        ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
        ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
        ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
        [':', '/', '.', '-', '_', '?', '&', '=', '%', '@', '#', '+'],
        [{ label: 'SPACE', action: 'space', wide: 'extra-wide' },
         { label: 'DEL', action: 'backspace', wide: 'wide' },
         { label: 'CLEAR', action: 'clear', wide: 'wide' },
         { label: 'DONE', action: 'done', wide: 'wide' }]
    ];

    // ==========================================================================
    // State
    // ==========================================================================
    var state = {
        playlists: [],
        activePlaylistIds: [DEFAULT_PLAYLIST.id],
        channels: [],
        categories: [],          // [{ name, code, channels: [...] }] — grouped by group-title
        activeCategoryIndex: 0,
        favorites: [],
        nowPlaying: null,
        zapContext: 'category',  // 'category' | 'favorites'
        zapList: [],
        hls: null,
        avplay: null,
        playerMode: null,
        playbackToken: 0,
        playbackTimeoutId: null,
        previousScreen: 'screen-grid',
        overlayTimeoutId: null,
        toastTimeoutId: null,
        keyboardBuffer: 'http://',
        dvr: { available: false, durationMs: 0, positionMs: 0, liveEdgeMs: 0, earliestMs: 0, seeking: false, lastEdgeSampleAt: 0 },
        dvrRefreshId: null,
        seekStepIndex: 0
    };

    var editingPlaylistId = null;

    var videoPlayer = document.getElementById('videoPlayer');

    function playbackUrlForLog(url) {
        try {
            var parsed = new URL(url);
            return parsed.protocol + '//' + parsed.host + parsed.pathname;
        } catch (e) {
            return '[invalid URL]';
        }
    }

    function avplayUrlForChannel(ch) {
        // This provider's master advertises a 1080p H.264 level that some
        // older TV firmware can decode for audio but cannot render reliably.
        // Keep the fallback limited to this known provider/channel.
        if (ch && ch.url === 'https://cdnb4u.wiseplayout.com/B4U_Bhojpuri/master.m3u8') {
            return 'https://cdnb4u.wiseplayout.com/B4U_Bhojpuri/HD720/HD720.m3u8';
        }
        return ch.url;
    }

    function playbackLog(stage, ch, details) {
        console.info('[playback]', stage, {
            channel: ch ? ch.name : '',
            url: ch ? playbackUrlForLog(ch.url) : '',
            player: state.playerMode || 'none',
            details: details || ''
        });
    }

    // ==========================================================================
    // Remote control keys — ChannelUp/Down and MediaPlayPause need explicit
    // registration. Arrow/Enter/Back are automatic on Tizen TVs.
    // ==========================================================================
    if (window.tizen && tizen.tvinputdevice) {
        try {
            tizen.tvinputdevice.registerKeyBatch([
                'ChannelUp', 'ChannelDown', 'MediaPlayPause',
                'MediaRewind', 'MediaFastForward'
            ]);
        } catch (e) {
            console.error('registerKeyBatch failed:', e);
        }
    }

    // ==========================================================================
    // Focus manager — zones backed by a matrix (array of rows) of elements.
    // ==========================================================================
    var Focus = {
        zones: {},
        currentZone: null,
        row: 0,
        col: 0,

        setZone: function (name, row, col) {
            this.currentZone = name;
            this.row = row || 0;
            this.col = col || 0;
            this.apply();
        },

        getMatrix: function () {
            var zone = this.zones[this.currentZone];
            return zone ? zone.getMatrix() : [];
        },

        apply: function () {
            var focused = document.querySelectorAll('.focused');
            for (var i = 0; i < focused.length; i++) focused[i].classList.remove('focused');

            var matrix = this.getMatrix();
            if (!matrix.length) return;
            if (this.row >= matrix.length) this.row = matrix.length - 1;
            if (this.row < 0) this.row = 0;
            var rowArr = matrix[this.row] || [];
            if (this.col >= rowArr.length) this.col = rowArr.length - 1;
            if (this.col < 0) this.col = 0;

            var el = rowArr[this.col];
            if (el) {
                el.classList.add('focused');
                el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
            }
        },

        move: function (dir) {
            var zone = this.zones[this.currentZone];
            if (!zone) return;
            var matrix = this.getMatrix();
            if (!matrix.length) return;
            var rowArr = matrix[this.row] || [];

            if (dir === 'left') {
                if (this.col > 0) { this.col--; this.apply(); }
                else if (zone.onEdge) zone.onEdge('left');
            } else if (dir === 'right') {
                if (this.col < rowArr.length - 1) { this.col++; this.apply(); }
                else if (zone.onEdge) zone.onEdge('right');
            } else if (dir === 'up') {
                if (this.row > 0) { this.row--; this.apply(); }
                else if (zone.onEdge) zone.onEdge('up');
            } else if (dir === 'down') {
                if (this.row < matrix.length - 1) { this.row++; this.apply(); }
                else if (zone.onEdge) zone.onEdge('down');
            }
        },

        select: function () {
            var matrix = this.getMatrix();
            var rowArr = matrix[this.row];
            var el = rowArr && rowArr[this.col];
            if (el) el.click();
        }
    };

    // Groups elements into visual rows by comparing their actual rendered
    // offsetTop, instead of assuming a fixed column count from pixel math.
    // This stays correct regardless of tile size, padding, or screen width —
    // a hardcoded column count silently drifts out of sync with the real
    // flex-wrap layout the moment either one changes.
    function rowsByLayout(elements) {
        var rows = [];
        var currentRow = [];
        var currentTop = null;
        for (var i = 0; i < elements.length; i++) {
            var el = elements[i];
            if (currentTop === null || el.offsetTop === currentTop) {
                currentRow.push(el);
            } else {
                rows.push(currentRow);
                currentRow = [el];
            }
            currentTop = el.offsetTop;
        }
        if (currentRow.length) rows.push(currentRow);
        return rows;
    }

    function leftEdgeToRail(zoneName) {
        Focus.zones[zoneName].onEdge = (function (existing) {
            return function (dir) {
                if (dir === 'left') {
                    Focus.setZone('iconRail', currentRailRow(), 0);
                } else if (existing) {
                    existing(dir);
                }
            };
        })(Focus.zones[zoneName].onEdge);
    }

    function currentRailRow() {
        if (document.getElementById('screen-categories').classList.contains('active') ||
            document.getElementById('screen-category-channels').classList.contains('active')) return 1;
        if (document.getElementById('screen-my-channels').classList.contains('active')) return 2;
        if (document.getElementById('screen-donate').classList.contains('active')) return 3;
        if (document.getElementById('screen-settings').classList.contains('active')) return 4;
        return 0;
    }

    // ==========================================================================
    // UI feedback helpers — loading indicator and toast popup
    // ==========================================================================
    function showLoading(visible) {
        document.getElementById('loadingIndicator').hidden = !visible;
    }

    // window.confirm() is not usable here: this UI is driven entirely by
    // synthetic clicks from remote-control key events (see Focus below), and
    // Tizen's WebKit does not expose the native confirm dialog to that D-pad
    // navigation. This modal is just another Focus zone instead.
    var pendingConfirmCallback = null;
    var confirmReturnZone = null;

    function showConfirm(message, confirmLabel, onConfirm) {
        confirmReturnZone = { name: Focus.currentZone, row: Focus.row, col: Focus.col };
        pendingConfirmCallback = onConfirm;
        document.getElementById('confirmMessage').textContent = message;
        document.getElementById('confirmYesBtn').textContent = confirmLabel;
        document.getElementById('confirmModal').hidden = false;
        Focus.setZone('confirmActions', 0, 0);
    }

    function hideConfirm() {
        document.getElementById('confirmModal').hidden = true;
        pendingConfirmCallback = null;
        if (confirmReturnZone) Focus.setZone(confirmReturnZone.name, confirmReturnZone.row, confirmReturnZone.col);
    }

    Focus.zones.confirmActions = {
        getMatrix: function () {
            return [[document.getElementById('confirmCancelBtn'), document.getElementById('confirmYesBtn')]];
        }
    };

    document.getElementById('confirmCancelBtn').addEventListener('click', hideConfirm);
    document.getElementById('confirmYesBtn').addEventListener('click', function () {
        var cb = pendingConfirmCallback;
        hideConfirm();
        if (cb) cb();
    });

    function showToast(message) {
        var toast = document.getElementById('toast');
        toast.textContent = message;
        toast.classList.add('visible');
        if (state.toastTimeoutId) clearTimeout(state.toastTimeoutId);
        state.toastTimeoutId = setTimeout(function () { toast.classList.remove('visible'); }, TOAST_MS);
    }

    function failPlayback(message) {
        stopPlayback();
        showToast(message);
    }

    // ==========================================================================
    // Screen switching
    // ==========================================================================
    function showScreen(id) {
        var screens = document.querySelectorAll('.screen');
        for (var i = 0; i < screens.length; i++) screens[i].classList.remove('active');
        document.getElementById(id).classList.add('active');
    }

    function switchToScreen(id) {
        showScreen(id);
        document.getElementById('navHome').classList.toggle('active', id === 'screen-grid');
        document.getElementById('navCategories').classList.toggle('active', id === 'screen-categories' || id === 'screen-category-channels');
        document.getElementById('navMyChannels').classList.toggle('active', id === 'screen-my-channels');
        document.getElementById('navDonate').classList.toggle('active', id === 'screen-donate');
        document.getElementById('navSettings').classList.toggle('active', id === 'screen-settings');

        if (id === 'screen-grid') {
            Focus.setZone('homeWelcome', 0, 0);
        } else if (id === 'screen-categories') {
            renderCategoriesScreen();
            Focus.setZone(state.categories.length ? 'categoriesGrid' : 'iconRail', state.categories.length ? 0 : 1, 0);
        } else if (id === 'screen-donate') {
            Focus.setZone('iconRail', 3, 0);
        } else if (id === 'screen-my-channels') {
            renderMyChannelsScreen();
            Focus.setZone('myChannelsGrid', 0, 0);
        } else if (id === 'screen-settings') {
            renderPlaylistList();
            Focus.setZone('playlistList', 0, 0);
        }
    }

    document.getElementById('navHome').addEventListener('click', function () { switchToScreen('screen-grid'); });
    document.getElementById('heroBrowseBtn').addEventListener('click', function () {
        switchToScreen('screen-categories');
    });
    document.getElementById('navCategories').addEventListener('click', function () { switchToScreen('screen-categories'); });
    document.getElementById('navMyChannels').addEventListener('click', function () { switchToScreen('screen-my-channels'); });
    document.getElementById('navDonate').addEventListener('click', function () { switchToScreen('screen-donate'); });
    document.getElementById('navSettings').addEventListener('click', function () { switchToScreen('screen-settings'); });

    Focus.zones.iconRail = {
        getMatrix: function () {
            return [[document.getElementById('navHome')], [document.getElementById('navCategories')], [document.getElementById('navMyChannels')], [document.getElementById('navDonate')], [document.getElementById('navSettings')]];
        },
        onEdge: function (dir) {
            if (dir !== 'right') return;
            if (document.getElementById('screen-categories').classList.contains('active') && state.categories.length) {
                Focus.setZone('categoriesGrid', 0, 0);
            } else if (document.getElementById('screen-category-channels').classList.contains('active')) {
                Focus.setZone('categoryChannelsGrid', 0, 0);
            } else if (document.getElementById('screen-settings').classList.contains('active')) {
                Focus.setZone('playlistList', 0, 0);
            } else if (document.getElementById('screen-donate').classList.contains('active')) {
                // no focusable content on the donate screen besides the rail
            } else if (document.getElementById('screen-my-channels').classList.contains('active')) {
                Focus.setZone('myChannelsGrid', 0, 0);
            } else if (visibleFavorites().length) {
                Focus.setZone('favoritesRow', 0, 0);
            }
        }
    };

    // ==========================================================================
    // M3U parsing
    // ==========================================================================
    function parseM3U(text) {
        var lines = text.split(/\r?\n/);
        var channels = [];
        var pending = null;
        var attrRegex = /([a-zA-Z0-9-]+)="([^"]*)"/g;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;

            if (line.indexOf('#EXTINF') === 0) {
                var attrs = {};
                var m;
                attrRegex.lastIndex = 0;
                while ((m = attrRegex.exec(line)) !== null) attrs[m[1].toLowerCase()] = m[2];
                var nameMatch = line.match(/,(.*)$/);
                pending = {
                    name: nameMatch ? nameMatch[1].trim() : 'Unnamed Channel',
                    logo: attrs['tvg-logo'] || '',
                    group: attrs['group-title'] || 'Other',
                    tvgId: attrs['tvg-id'] || '',
                    tvgCountry: attrs['tvg-country'] || '',
                    catchup: attrs.catchup || '',
                    catchupDays: attrs['catchup-days'] || '',
                    catchupSource: attrs['catchup-source'] || '',
                    timeshift: attrs.timeshift || '',
                    archive: attrs.archive || '',
                    catchupTime: attrs['catchup-time'] || '',
                    catchupDuration: attrs['catchup-duration'] || ''
                };
            } else if (pending && line.indexOf('#EXTVLCOPT:') === 0) {
                var option = line.slice(12).split('=');
                var optionName = option.shift().toLowerCase();
                var optionValue = option.join('=');
                if (optionName === 'catchup' || optionName === 'catchup-days' ||
                    optionName === 'catchup-source' || optionName === 'timeshift' ||
                    optionName === 'archive' || optionName === 'catchup-time' ||
                    optionName === 'catchup-duration') {
                    pending[optionName === 'catchup-days' ? 'catchupDays' :
                        optionName === 'catchup-source' ? 'catchupSource' :
                        optionName === 'catchup-time' ? 'catchupTime' :
                        optionName === 'catchup-duration' ? 'catchupDuration' : optionName] = optionValue.trim();
                }
            } else if (line.indexOf('#') !== 0) {
                if (pending) { pending.url = line; channels.push(pending); pending = null; }
            }
        }
        return channels;
    }

    // Categories are grouped per source playlist (not merged across
    // playlists that happen to share a group-title) so multiple active
    // playlists stay visually separate, per playlist, on the Categories screen.
    function rebuildCategories() {
        var order = [];
        var byPlaylist = {};
        state.channels.forEach(function (ch) {
            var pid = ch.playlistId || '';
            if (!byPlaylist[pid]) { byPlaylist[pid] = {}; order.push(pid); }
            var key = ch.group || 'Other';
            if (!byPlaylist[pid][key]) {
                byPlaylist[pid][key] = { name: key, code: ch.tvgCountry || '', channels: [], playlistId: pid, playlistName: ch.playlistName || '' };
            }
            byPlaylist[pid][key].channels.push(ch);
        });
        state.categories = [];
        order.forEach(function (pid) {
            var groups = Object.keys(byPlaylist[pid]).map(function (k) { return byPlaylist[pid][k]; })
                .sort(function (a, b) { return a.name.localeCompare(b.name); });
            state.categories = state.categories.concat(groups);
        });
        state.activeCategoryIndex = 0;
    }

    // ==========================================================================
    // Playlists (multiple, persisted; add/edit/delete via Settings). The
    // built-in default is the real iptv-org country-indexed catalog, not a
    // local test stub.
    // ==========================================================================
    function loadPlaylistsFromStorage() {
        var stored = null;
        try { stored = JSON.parse(localStorage.getItem(PLAYLISTS_KEY) || 'null'); } catch (e) { stored = null; }
        state.playlists = (stored && stored.length) ? stored : [DEFAULT_PLAYLIST];

        // The built-in entry (id === DEFAULT_PLAYLIST.id) always tracks the
        // current default URL — a device that ran an older build with a
        // different built-in URL would otherwise keep loading that stale
        // playlist forever, since it's indistinguishable from a user's own
        // saved playlist once it's in storage.
        var builtIn = state.playlists.find(function (p) { return p.id === DEFAULT_PLAYLIST.id; });
        if (builtIn && builtIn.url !== DEFAULT_PLAYLIST.url) {
            builtIn.url = DEFAULT_PLAYLIST.url;
            builtIn.name = DEFAULT_PLAYLIST.name;
            savePlaylists();
        }

        var raw = null;
        try { raw = localStorage.getItem(ACTIVE_PLAYLISTS_KEY); } catch (e) { raw = null; }
        var storedActive;
        if (raw === null) {
            storedActive = [DEFAULT_PLAYLIST.id];
        } else {
            try {
                var parsed = JSON.parse(raw);
                storedActive = Array.isArray(parsed) ? parsed : [raw];
            } catch (e) {
                // Pre-multi-playlist storage held a single id as a bare string,
                // not JSON — JSON.parse throws on it, so fall back to that raw value.
                storedActive = [raw];
            }
        }
        var validIds = state.playlists.map(function (p) { return p.id; });
        state.activePlaylistIds = storedActive.filter(function (id) { return validIds.indexOf(id) !== -1; });
    }

    function savePlaylists() {
        try { localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(state.playlists)); } catch (e) { /* non-fatal */ }
    }

    function saveActivePlaylistIds() {
        try { localStorage.setItem(ACTIVE_PLAYLISTS_KEY, JSON.stringify(state.activePlaylistIds)); } catch (e) { /* non-fatal */ }
    }

    function deriveNameFromUrl(url) {
        try {
            var u = new URL(url);
            var last = u.pathname.split('/').filter(Boolean).pop();
            return u.hostname + (last ? ' / ' + last : '');
        } catch (e) {
            return url.length > 40 ? url.slice(0, 40) + '…' : url;
        }
    }

    // Fetches every currently-active playlist in parallel and merges their
    // channels. Each playlist is fetched/parsed independently — one bad URL
    // shows an error for that playlist without blanking out the others.
    // Used only for the initial bulk load at boot; interactive add/toggle/
    // remove use the targeted helpers below instead, so a single playlist
    // change doesn't have to wait on (or re-fetch) every other active one.
    // A hung fetch (no route to the host, rather than a fast connection
    // refusal) would otherwise never resolve or reject, leaving the loading
    // indicator stuck on screen forever with nothing left to clear it.
    function fetchWithTimeout(url) {
        return new Promise(function (resolve, reject) {
            var settled = false;
            var timer = setTimeout(function () {
                if (settled) return;
                settled = true;
                reject(new Error('Timed out'));
            }, FETCH_TIMEOUT_MS);
            fetch(url).then(function (res) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(res);
            }, function (err) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err);
            });
        });
    }

    function fetchPlaylistChannels(pl) {
        return fetchWithTimeout(pl.url)
            .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.text(); })
            .then(function (text) {
                var parsed = parseM3U(text);
                if (!parsed.length) throw new Error('No channels found');
                parsed.forEach(function (ch) { ch.playlistId = pl.id; ch.playlistName = pl.name; });
                return parsed;
            });
    }

    function refreshActiveChannels(options) {
        options = options || {};
        var activePlaylists = state.playlists.filter(function (p) { return state.activePlaylistIds.indexOf(p.id) !== -1; });

        if (!activePlaylists.length) {
            state.channels = [];
            rebuildCategories();
            renderHero();
            renderFavoritesRow();
            showLoading(false);
            if (options.screen) switchToScreen(options.screen);
            return;
        }

        showLoading(true);
        Promise.all(activePlaylists.map(function (pl) {
            return fetchPlaylistChannels(pl)
                .then(function (channels) { return { channels: channels, error: null, name: pl.name }; })
                .catch(function (err) { return { channels: [], error: err, name: pl.name }; });
        })).then(function (results) {
            var allChannels = [];
            var failures = [];
            results.forEach(function (r) {
                if (r.error) failures.push(r.name + ': ' + r.error.message);
                else allChannels = allChannels.concat(r.channels);
            });
            state.channels = allChannels;
            rebuildCategories();
            renderHero();
            renderFavoritesRow();
            showLoading(false);
            if (failures.length) showToast('Could not load ' + failures.join('; '));
            if (options.screen) switchToScreen(options.screen);
        });
    }

    // Instantly drops a playlist's channels from the merged list — no
    // network round-trip needed since the remaining playlists' channels are
    // already loaded in memory.
    function removeChannelsForPlaylist(playlistId) {
        state.channels = state.channels.filter(function (ch) { return ch.playlistId !== playlistId; });
        rebuildCategories();
        renderHero();
        renderFavoritesRow();
    }

    // Fetches one playlist and merges its channels in, replacing any it
    // already contributed (e.g. re-activating it, or after editing its URL).
    function loadChannelsForPlaylist(pl) {
        showLoading(true);
        return fetchPlaylistChannels(pl)
            .then(function (channels) {
                state.channels = state.channels.filter(function (ch) { return ch.playlistId !== pl.id; }).concat(channels);
                rebuildCategories();
                renderHero();
                renderFavoritesRow();
                showLoading(false);
                return null;
            })
            .catch(function (err) {
                state.channels = state.channels.filter(function (ch) { return ch.playlistId !== pl.id; });
                rebuildCategories();
                renderHero();
                renderFavoritesRow();
                showLoading(false);
                return err;
            });
    }

    // ==========================================================================
    // Favorites — the saved list persists regardless of which playlists are
    // active (deactivating a playlist doesn't delete its favorites, only
    // deleting the playlist does), but what's actually *shown* is filtered
    // to favorites whose playlist is currently active, same as Categories.
    // ==========================================================================
    function loadFavorites() {
        try {
            var raw = localStorage.getItem(FAVORITES_KEY);
            state.favorites = raw ? JSON.parse(raw) : [];
        } catch (e) { state.favorites = []; }
    }

    function saveFavorites() {
        try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(state.favorites)); } catch (e) { /* non-fatal */ }
    }

    function visibleFavorites() {
        return state.favorites.filter(function (f) {
            return !f.playlistId || state.activePlaylistIds.indexOf(f.playlistId) !== -1;
        });
    }

    function isFavorited(ch) {
        return state.favorites.some(function (f) { return f.url === ch.url; });
    }

    function toggleFavorite(ch) {
        if (!ch) return;
        var idx = state.favorites.findIndex(function (f) { return f.url === ch.url; });
        if (idx === -1) {
            state.favorites.push({ name: ch.name, url: ch.url, logo: ch.logo, group: ch.group, tvgCountry: ch.tvgCountry, playlistId: ch.playlistId });
            showToast('Added to Favorites');
        } else {
            state.favorites.splice(idx, 1);
            showToast('Removed from Favorites');
        }
        saveFavorites();
        renderFavoritesRow();
        updateFavoriteButton();
    }

    // ==========================================================================
    // Hero banner
    // ==========================================================================
    function renderHero() {
        var bg = document.getElementById('heroBg');
        var title = document.getElementById('heroTitle');
        var subtitle = document.getElementById('heroSubtitle');
        bg.style.backgroundImage = '';
        title.textContent = 'Entertainment starts here';
        subtitle.textContent = 'Live TV, favourites and channels made for your home screen.';
    }

    // ==========================================================================
    // Rendering — Favorites row (Home screen)
    // ==========================================================================
    function renderFavoritesRow() {
        var row = document.getElementById('favoritesRow');
        row.innerHTML = '';

        var visible = visibleFavorites();
        if (!visible.length) {
            var hint = document.createElement('div');
            hint.className = 'empty-hint';
            hint.textContent = 'No favorites yet — press the Favorite button while watching a channel';
            row.appendChild(hint);
            return;
        }

        visible.forEach(function (ch) {
            row.appendChild(buildChannelTile(ch, function () { playChannel(ch, 'favorites'); }));
        });
    }

    Focus.zones.favoritesRow = {
        getMatrix: function () { return [Array.prototype.slice.call(document.querySelectorAll('#favoritesRow .channel-tile'))]; }
    };

    Focus.zones.homeWelcome = {
        getMatrix: function () { return [[document.getElementById('heroBrowseBtn')]]; },
        onEdge: function (dir) {
            if (dir === 'down' && visibleFavorites().length) Focus.setZone('favoritesRow', 0, 0);
            if (dir === 'left') Focus.setZone('iconRail', 0, 0);
        }
    };
    leftEdgeToRail('favoritesRow');

    function myChannelMatches(ch) {
        var name = ch.name.toLowerCase();
        return name.indexOf('dangal tv') !== -1 ||
            name.indexOf('b4u bhojpuri') !== -1 ||
            name.indexOf('manoranjan tv') !== -1 ||
            name.indexOf('shemaroo tv') !== -1;
    }

    function renderMyChannelsScreen() {
        var grid = document.getElementById('myChannelsGrid');
        grid.innerHTML = '';
        var channels = [];
        var seen = {};
        state.channels.forEach(function (ch) {
            if (myChannelMatches(ch) && !seen[ch.name + '|' + ch.url]) {
                seen[ch.name + '|' + ch.url] = true;
                channels.push(ch);
            }
        });
        if (!channels.length) {
            var hint = document.createElement('div');
            hint.className = 'empty-hint';
            hint.textContent = 'My channels are not available in the active playlist.';
            grid.appendChild(hint);
            return;
        }
        channels.forEach(function (ch) {
            grid.appendChild(buildChannelTile(ch, function () { playChannel(ch, 'my-channels'); }));
        });
    }

    Focus.zones.myChannelsGrid = {
        getMatrix: function () {
            return rowsByLayout(Array.prototype.slice.call(document.querySelectorAll('#myChannelsGrid .channel-tile')));
        }
    };
    leftEdgeToRail('myChannelsGrid');

    // ==========================================================================
    // Rendering — Categories browse screen. A two-column alphabetical list:
    // more scannable than tiles for 100+ text entries with no imagery, and
    // the row-pair layout (two per row, filled in order) keeps vertical
    // scrolling to half of a single-column list.
    // ==========================================================================
    function renderCategoriesScreen() {
        var grid = document.getElementById('categoriesGrid');
        grid.innerHTML = '';

        if (!state.categories.length) {
            var hint = document.createElement('div');
            hint.className = 'empty-hint';
            hint.textContent = 'No channels yet — activate a playlist in Settings';
            grid.appendChild(hint);
            return;
        }

        var section = null;
        var lastPlaylistId = null;
        state.categories.forEach(function (cat, i) {
            if (cat.playlistId !== lastPlaylistId) {
                lastPlaylistId = cat.playlistId;
                var header = document.createElement('div');
                header.className = 'category-section-header';
                header.textContent = cat.playlistName || 'Playlist';
                grid.appendChild(header);

                section = document.createElement('div');
                section.className = 'category-section-grid';
                grid.appendChild(section);
            }

            var row = document.createElement('button');
            row.className = 'category-row-item';
            row.tabIndex = -1;

            var letter = document.createElement('span');
            letter.className = 'category-letter';
            letter.textContent = cat.name.charAt(0).toUpperCase();
            row.appendChild(letter);

            var label = document.createElement('span');
            label.className = 'category-label';
            label.textContent = cat.name;
            row.appendChild(label);

            var count = document.createElement('span');
            count.className = 'category-count';
            count.textContent = cat.channels.length;
            row.appendChild(count);

            row.addEventListener('click', function () { openCategoryChannels(i); });
            section.appendChild(row);
        });
    }

    Focus.zones.categoriesGrid = {
        getMatrix: function () { return rowsByLayout(Array.prototype.slice.call(document.querySelectorAll('#categoriesGrid .category-row-item'))); }
    };
    leftEdgeToRail('categoriesGrid');

    // ==========================================================================
    // Rendering — Channels within a selected category
    // ==========================================================================
    function openCategoryChannels(index) {
        state.activeCategoryIndex = index;
        renderCategoryChannelsScreen();
        showScreen('screen-category-channels');
        document.getElementById('navCategories').classList.add('active');
        Focus.setZone('categoryChannelsGrid', 0, 0);
    }

    function renderCategoryChannelsScreen() {
        var cat = state.categories[state.activeCategoryIndex];
        document.getElementById('categoryChannelsTitle').textContent = cat ? cat.name + ' Channels' : 'Channels';
        var grid = document.getElementById('categoryChannelsGrid');
        grid.innerHTML = '';
        if (!cat) return;
        cat.channels.forEach(function (ch) {
            grid.appendChild(buildChannelTile(ch, function () { playChannel(ch, 'category'); }));
        });
    }

    Focus.zones.categoryChannelsGrid = {
        getMatrix: function () { return rowsByLayout(Array.prototype.slice.call(document.querySelectorAll('#categoryChannelsGrid .channel-tile'))); }
    };
    leftEdgeToRail('categoryChannelsGrid');

    // ==========================================================================
    // Shared channel tile builder
    // ==========================================================================
    function buildChannelTile(ch, onClick) {
        var tile = document.createElement('button');
        tile.className = 'channel-tile';
        tile.tabIndex = -1;
        tile.__channel = ch;

        var thumb = document.createElement('div');
        thumb.className = 'tile-thumb';
        if (ch.logo) {
            thumb.style.backgroundImage = 'url(' + JSON.stringify(ch.logo) + ')';
        } else {
            thumb.appendChild(fallbackLetter(ch.name));
        }
        thumb.appendChild(liveBadge());
        if (isFavorited(ch)) {
            var star = document.createElement('div');
            star.className = 'fav-badge';
            star.textContent = '\u2605';
            thumb.appendChild(star);
        }

        var nameEl = document.createElement('div');
        nameEl.className = 'tile-name';
        nameEl.textContent = ch.name;

        tile.appendChild(thumb);
        tile.appendChild(nameEl);
        tile.addEventListener('click', onClick);
        return tile;
    }

    function liveBadge() {
        var el = document.createElement('div');
        el.className = 'live-badge';
        el.textContent = 'LIVE';
        return el;
    }

    function fallbackLetter(name) {
        var el = document.createElement('div');
        el.className = 'tile-fallback';
        el.textContent = (name || '?').charAt(0).toUpperCase();
        return el;
    }

    // ==========================================================================
    // Settings screen — playlist list with explicit Edit / Delete buttons
    // ==========================================================================
    function renderPlaylistList() {
        var list = document.getElementById('playlistList');
        list.innerHTML = '';

        state.playlists.forEach(function (pl) {
            var isActive = state.activePlaylistIds.indexOf(pl.id) !== -1;

            var wrapper = document.createElement('div');
            wrapper.className = 'playlist-row-wrapper';

            var main = document.createElement('button');
            main.className = 'playlist-row' + (isActive ? ' active' : '');
            main.tabIndex = -1;

            var checkbox = document.createElement('span');
            checkbox.className = 'playlist-checkbox' + (isActive ? ' checked' : '');
            checkbox.textContent = isActive ? '✓' : '';
            main.appendChild(checkbox);

            var textWrap = document.createElement('div');
            textWrap.className = 'playlist-row-text';

            var name = document.createElement('div');
            name.className = 'playlist-name';
            name.textContent = pl.name;

            var url = document.createElement('div');
            url.className = 'playlist-url';
            url.textContent = pl.url;

            textWrap.appendChild(name);
            textWrap.appendChild(url);
            main.appendChild(textWrap);
            main.addEventListener('click', function () { toggleActivePlaylist(pl); });

            var editBtn = document.createElement('button');
            editBtn.className = 'playlist-action-btn';
            editBtn.tabIndex = -1;
            editBtn.textContent = 'Edit';
            editBtn.addEventListener('click', function () { openAddPlaylistScreen(pl); });

            var deleteBtn = document.createElement('button');
            deleteBtn.className = 'playlist-action-btn delete';
            deleteBtn.tabIndex = -1;
            deleteBtn.textContent = 'Delete';
            deleteBtn.addEventListener('click', function () { removePlaylist(pl); });

            wrapper.appendChild(main);
            wrapper.appendChild(editBtn);
            wrapper.appendChild(deleteBtn);
            list.appendChild(wrapper);
        });

        var addRow = document.createElement('button');
        addRow.className = 'playlist-row add-row';
        addRow.tabIndex = -1;
        addRow.textContent = '+ Add New Playlist';
        addRow.addEventListener('click', function () { openAddPlaylistScreen(null); });
        list.appendChild(addRow);

        if (!state.playlists.some(function (p) { return p.url === IPTV_ORG_URL; })) {
            var openChannelsRow = document.createElement('button');
            openChannelsRow.className = 'playlist-row add-row';
            openChannelsRow.tabIndex = -1;
            openChannelsRow.textContent = '+ Add IPTV-ORG Open Channels';
            openChannelsRow.addEventListener('click', addIptvOrgPlaylist);
            list.appendChild(openChannelsRow);
        }
    }

    Focus.zones.playlistList = {
        getMatrix: function () {
            var wrappers = document.querySelectorAll('.playlist-row-wrapper');
            var rows = Array.prototype.map.call(wrappers, function (w) {
                return Array.prototype.slice.call(w.querySelectorAll('button'));
            });
            var otherRows = document.querySelectorAll('.playlist-row.add-row');
            Array.prototype.forEach.call(otherRows, function (btn) { rows.push([btn]); });
            return rows;
        }
    };
    leftEdgeToRail('playlistList');

    function toggleActivePlaylist(pl) {
        var idx = state.activePlaylistIds.indexOf(pl.id);
        if (idx === -1) {
            state.activePlaylistIds.push(pl.id);
            saveActivePlaylistIds();
            renderPlaylistList();
            Focus.setZone('playlistList', 0, 0);
            loadChannelsForPlaylist(pl).then(function (err) {
                if (err) showToast('Could not load "' + pl.name + '": ' + err.message);
            });
        } else {
            state.activePlaylistIds.splice(idx, 1);
            saveActivePlaylistIds();
            renderPlaylistList();
            Focus.setZone('playlistList', 0, 0);
            removeChannelsForPlaylist(pl.id);
        }
    }

    function addIptvOrgPlaylist() {
        var newPl = { id: 'pl_' + Date.now(), name: deriveNameFromUrl(IPTV_ORG_URL), url: IPTV_ORG_URL };
        state.playlists.push(newPl);
        state.activePlaylistIds.push(newPl.id);
        savePlaylists();
        saveActivePlaylistIds();
        switchToScreen('screen-settings');
        showToast('Playlist added');
        loadChannelsForPlaylist(newPl).then(function (err) {
            if (err) showToast('Could not load "' + newPl.name + '": ' + err.message);
        });
    }

    function removePlaylist(pl) {
        if (state.playlists.length <= 1) { showToast('You need at least one playlist'); return; }
        showConfirm('Remove "' + pl.name + '"?', 'Delete', function () {
            state.playlists = state.playlists.filter(function (p) { return p.id !== pl.id; });
            state.activePlaylistIds = state.activePlaylistIds.filter(function (id) { return id !== pl.id; });
            savePlaylists();
            saveActivePlaylistIds();

            // Favorited channels sourced from the deleted playlist no longer exist.
            var hadFavorites = state.favorites.some(function (f) { return f.playlistId === pl.id; });
            if (hadFavorites) {
                state.favorites = state.favorites.filter(function (f) { return f.playlistId !== pl.id; });
                saveFavorites();
            }

            removeChannelsForPlaylist(pl.id);
            renderPlaylistList();
            Focus.setZone('playlistList', 0, 0);
            showToast('Playlist removed');
        });
    }

    // ==========================================================================
    // Add / Edit Playlist screen (on-screen keyboard)
    // ==========================================================================
    function openAddPlaylistScreen(playlist) {
        editingPlaylistId = playlist ? playlist.id : null;
        state.keyboardBuffer = playlist ? playlist.url : 'http://';
        document.getElementById('addPlaylistTitle').textContent = playlist ? 'Edit Playlist' : 'Add M3U Playlist';
        updateUrlDisplay();
        showScreen('screen-add');
        Focus.setZone('keyboard', 0, 0);
    }

    function updateUrlDisplay() {
        document.getElementById('urlText').textContent = state.keyboardBuffer;
    }

    function buildKeyboard() {
        var container = document.getElementById('keyboard');
        container.innerHTML = '';
        KEYBOARD_ROWS.forEach(function (row) {
            var rowEl = document.createElement('div');
            rowEl.className = 'keyboard-row';
            row.forEach(function (keyDef) {
                var isObj = typeof keyDef === 'object';
                var btn = document.createElement('button');
                btn.className = 'key' + (isObj && keyDef.wide ? ' ' + keyDef.wide : '');
                btn.textContent = isObj ? keyDef.label : keyDef;
                btn.tabIndex = -1;
                btn.addEventListener('click', function () {
                    if (!isObj) state.keyboardBuffer += keyDef;
                    else if (keyDef.action === 'space') state.keyboardBuffer += ' ';
                    else if (keyDef.action === 'backspace') state.keyboardBuffer = state.keyboardBuffer.slice(0, -1);
                    else if (keyDef.action === 'clear') state.keyboardBuffer = '';
                    else if (keyDef.action === 'done') { submitPlaylistUrl(); return; }
                    updateUrlDisplay();
                });
                rowEl.appendChild(btn);
            });
            container.appendChild(rowEl);
        });
    }

    function submitPlaylistUrl() {
        var url = state.keyboardBuffer.trim();
        if (!url || url === 'http://' || url === 'https://') { showToast('Enter a valid playlist URL first'); return; }

        if (editingPlaylistId) {
            var pl = state.playlists.find(function (p) { return p.id === editingPlaylistId; });
            if (!pl) return;
            pl.url = url;
            pl.name = deriveNameFromUrl(url);
            savePlaylists();
            switchToScreen('screen-settings');
            showToast('Playlist updated');
            if (state.activePlaylistIds.indexOf(pl.id) !== -1) {
                loadChannelsForPlaylist(pl).then(function (err) {
                    if (err) showToast('Could not load "' + pl.name + '": ' + err.message);
                });
            }
        } else {
            var newPl = { id: 'pl_' + Date.now(), name: deriveNameFromUrl(url), url: url };
            state.playlists.push(newPl);
            state.activePlaylistIds.push(newPl.id);
            savePlaylists();
            saveActivePlaylistIds();
            switchToScreen('screen-settings');
            showToast('Playlist added');
            loadChannelsForPlaylist(newPl).then(function (err) {
                if (err) showToast('Could not load "' + newPl.name + '": ' + err.message);
            });
        }
    }

    Focus.zones.keyboard = {
        getMatrix: function () {
            var rows = document.querySelectorAll('#keyboard .keyboard-row');
            return Array.prototype.map.call(rows, function (r) { return Array.prototype.slice.call(r.querySelectorAll('.key')); });
        },
        onEdge: function (dir) { if (dir === 'down') Focus.setZone('addActions', 0, 0); }
    };
    Focus.zones.addActions = {
        getMatrix: function () { return [Array.prototype.slice.call(document.querySelectorAll('.add-actions .btn'))]; },
        onEdge: function (dir) { if (dir === 'up') Focus.setZone('keyboard', KEYBOARD_ROWS.length - 1, 0); }
    };

    document.getElementById('loadPlaylistBtn').addEventListener('click', submitPlaylistUrl);
    document.getElementById('cancelAddBtn').addEventListener('click', function () {
        switchToScreen(editingPlaylistId ? 'screen-settings' : 'screen-grid');
    });

    function resetDvrState() {
        if (state.dvrRefreshId) {
            clearInterval(state.dvrRefreshId);
            state.dvrRefreshId = null;
        }
        state.dvr = { available: false, durationMs: 0, positionMs: 0, liveEdgeMs: 0, earliestMs: 0, seeking: false, lastEdgeSampleAt: 0 };
        updateDvrUi();
    }

    function parseLiveDuration(value) {
        if (typeof value !== 'string' && typeof value !== 'number') return 0;
        var duration = Number(value);
        return isFinite(duration) && duration > 0 ? duration : 0;
    }

    function hasCatchupTemplate(ch) {
        if (!ch || !ch.catchupSource) return false;
        return /^https?:\/\//i.test(ch.catchupSource) &&
            /(\{start\}|\{end\}|\{duration\}|\\\$UTC|\$START|\$END|%s)/i.test(ch.catchupSource);
    }

    function updateCatchupUi() {
        var status = document.getElementById('catchupStatus');
        if (!state.nowPlaying || !hasCatchupTemplate(state.nowPlaying)) {
            status.textContent = 'Catch-up is not available for this channel.';
            return;
        }
        status.textContent = 'Catch-up metadata found; program times are required to play recordings.';
    }

    function updateDvrUi() {
        var dvr = state.dvr;
        var track = document.getElementById('timelineBtn');
        var fill = document.getElementById('timelineFill');
        var status = document.getElementById('timelineStatus');
        var position = document.getElementById('timelinePosition');
        if (!dvr.available || !dvr.durationMs) {
            track.disabled = true;
            fill.style.width = '0%';
            status.textContent = 'Live rewind unavailable for this channel';
            position.textContent = 'LIVE';
            return;
        }
        track.disabled = false;
        var ratio = Math.max(0, Math.min(1, dvr.positionMs / dvr.liveEdgeMs));
        fill.style.width = (ratio * 100) + '%';
        var availableMinutes = Math.floor(dvr.durationMs / 60000);
        status.textContent = 'Live rewind: ' + (availableMinutes < 1 ? 'less than 1 minute' : availableMinutes + ' minutes') + ' available';
        var behindMs = Math.max(0, dvr.liveEdgeMs - dvr.positionMs);
        position.textContent = behindMs < 2000 ? 'LIVE' : formatDuration(behindMs) + ' behind live';
    }

    function formatDuration(milliseconds) {
        var totalSeconds = Math.floor(milliseconds / 1000);
        var minutes = Math.floor(totalSeconds / 60);
        var seconds = totalSeconds % 60;
        return minutes ? minutes + 'm ' + seconds + 's' : seconds + 's';
    }

    function refreshDvrRange() {
        if (state.playerMode !== 'AVPlay' || !state.avplay || state.dvr.seeking) return false;
        try {
            var liveDurationMs = parseLiveDuration(state.avplay.getStreamingProperty('GET_LIVE_DURATION'));
            var currentMs = Number(state.avplay.getCurrentTime());
            if (!liveDurationMs || !isFinite(currentMs) || currentMs < 0) {
                state.dvr.available = false;
                updateDvrUi();
                return false;
            }
            // Some older firmware returns GET_LIVE_DURATION in seconds while
            // getCurrentTime()/seekTo() use milliseconds.
            if (liveDurationMs < 1000 && currentMs > 10000) liveDurationMs *= 1000;
            state.dvr.available = true;
            state.dvr.durationMs = liveDurationMs;
            var nowMs = Date.now();
            if (state.dvr.lastEdgeSampleAt && state.dvr.liveEdgeMs) {
                state.dvr.liveEdgeMs += Math.max(0, nowMs - state.dvr.lastEdgeSampleAt);
            } else {
                state.dvr.liveEdgeMs = Math.max(currentMs, liveDurationMs);
            }
            state.dvr.liveEdgeMs = Math.max(state.dvr.liveEdgeMs, currentMs);
            state.dvr.lastEdgeSampleAt = nowMs;
            state.dvr.earliestMs = Math.max(0, state.dvr.liveEdgeMs - liveDurationMs);
            state.dvr.positionMs = Math.max(state.dvr.earliestMs, Math.min(currentMs, state.dvr.liveEdgeMs));
            updateDvrUi();
            return true;
        } catch (error) {
            state.dvr.available = false;
            updateDvrUi();
            return false;
        }
    }

    function startDvrMonitoring() {
        resetDvrState();
        refreshDvrRange();
        state.dvrRefreshId = setInterval(refreshDvrRange, DVR_REFRESH_MS);
    }

    function avplaySeek(targetMs, onSuccess, onError) {
        try {
            // Newer AVPlay versions expose asynchronous callbacks.
            state.avplay.seekTo(targetMs, onSuccess, onError);
        } catch (callbackError) {
            try {
                // Older target TVs expose only seekTo(milliseconds).
                state.avplay.seekTo(targetMs);
                setTimeout(onSuccess, 500);
            } catch (seekError) {
                onError(seekError);
            }
        }
    }

    function seekPlayback(deltaMs) {
        if (state.playerMode === 'AVPlay' && state.avplay) {
            if (!refreshDvrRange() || !state.dvr.available) {
                showToast('Live rewind unavailable for this channel');
                showOverlay();
                return;
            }
            if (state.dvr.seeking) {
                showToast('Seek already in progress');
                return;
            }
            var targetMs = Math.max(state.dvr.earliestMs,
                Math.min(state.dvr.liveEdgeMs, state.dvr.positionMs + deltaMs));
            if (targetMs === state.dvr.positionMs) {
                showToast(deltaMs < 0 ? 'Already at the earliest available point' : 'Already at the live edge');
                return;
            }
            state.dvr.seeking = true;
            try {
                avplaySeek(targetMs, function () {
                    state.dvr.seeking = false;
                    refreshDvrRange();
                    showOverlay();
                }, function (error) {
                    state.dvr.seeking = false;
                    console.warn('[playback] AVPlay seek failed', error);
                    showToast('Seeking is not available for this channel');
                    refreshDvrRange();
                });
                playbackLog('seek', state.nowPlaying, (deltaMs / 1000) + ' seconds');
            } catch (error) {
                state.dvr.seeking = false;
                console.warn('[playback] AVPlay seek unavailable', error);
                showToast('Seeking is not available for this channel');
            }
        } else if (videoPlayer.duration && isFinite(videoPlayer.duration)) {
            videoPlayer.currentTime = Math.max(0, Math.min(
                videoPlayer.duration,
                videoPlayer.currentTime + (deltaMs / 1000)
            ));
        }
        showOverlay();
    }

    function goLive() {
        if (state.playerMode !== 'AVPlay' || !state.avplay || !refreshDvrRange()) {
            showToast('Live edge is unavailable for this channel');
            return;
        }
        if (state.dvr.seeking) return;
        state.dvr.seeking = true;
        try {
            avplaySeek(state.dvr.liveEdgeMs, function () {
                state.dvr.seeking = false;
                refreshDvrRange();
                showToast('Live');
                showOverlay();
            }, function (error) {
                state.dvr.seeking = false;
                console.warn('[playback] AVPlay go-live failed', error);
                showToast('Unable to return to live');
            });
        } catch (error) {
            state.dvr.seeking = false;
            console.warn('[playback] AVPlay go-live unavailable', error);
            showToast('Unable to return to live');
        }
    }

    // ==========================================================================
    // Player screen — fullscreen, favorite toggled via a real focusable button
    // (long-press proved unreliable on this remote/WebKit combination).
    // ==========================================================================
    function playChannel(ch, context) {
        var activeScreen = document.querySelector('.screen.active');
        if (activeScreen && activeScreen.id !== 'screen-player') {
            state.previousScreen = activeScreen.id;
        }
        state.nowPlaying = ch;
        state.zapContext = context;
        state.zapList = context === 'favorites' ? visibleFavorites() :
            context === 'my-channels' ? state.channels.filter(myChannelMatches) :
                (state.categories[state.activeCategoryIndex] || { channels: [] }).channels;
        showScreen('screen-player');
        startPlayback();
    }

    function zapChannel(delta) {
        var list = state.zapList;
        if (!list || !list.length) return;
        var idx = list.findIndex(function (c) { return c.url === state.nowPlaying.url; });
        if (idx === -1) idx = 0;
        idx = (idx + delta + list.length) % list.length;
        playChannel(list[idx], state.zapContext);
    }

    function startPlayback() {
        var ch = state.nowPlaying;
        if (!ch) return;

        stopPlayback();
        var token = ++state.playbackToken;

        document.getElementById('nowPlayingName').textContent = ch.name;
        document.getElementById('nowPlayingGroup').textContent = ch.group || '';
        var logoEl = document.getElementById('nowPlayingLogo');
        logoEl.style.backgroundImage = ch.logo ? ('url(' + JSON.stringify(ch.logo) + ')') : '';
        updateFavoriteButton();
        resetDvrState();
        updateCatchupUi();

        var avplay = window.webapis && window.webapis.avplay;
        if (avplay) {
            state.avplay = avplay;
            state.playerMode = 'AVPlay';
            document.getElementById('screen-player').classList.add('avplay-active');
            document.getElementById('avplayObject').style.display = 'block';
            videoPlayer.style.display = 'none';
            var avplayUrl = avplayUrlForChannel(ch);
            playbackLog('open', ch, avplayUrl === ch.url ? '' : '720p child playlist');
            try {
                avplay.open(avplayUrl);
                try {
                    avplay.setStreamingProperty('ADAPTIVE_INFO', 'FIXED_MAX_RESOLUTION=1280X720');
                    playbackLog('stream-cap', ch, '1280x720');
                } catch (error) {
                    console.warn('[playback] adaptive resolution cap unavailable', error);
                }
                avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_FULL_SCREEN');
                avplay.setDisplayRect(0, 0, 1920, 1080);
                avplay.setListener({
                    onbufferingstart: function () { playbackLog('buffering', ch, 'start'); },
                    onbufferingprogress: function (percent) { playbackLog('buffering', ch, percent + '%'); },
                    onbufferingcomplete: function () {
                        if (token !== state.playbackToken) return;
                        clearPlaybackTimeout();
                        var playerState = 'unknown';
                        try {
                            playerState = avplay.getState();
                        } catch (error) {
                            console.warn('[playback] AVPlay state unavailable', error);
                        }
                        playbackLog('playing', ch, playerState);
                        updatePlayPauseButton();
                        startDvrMonitoring();
                    },
                    onstreamcompleted: function () {
                        if (token !== state.playbackToken) return;
                        playbackLog('completed', ch);
                    },
                    onerror: function (error) {
                        if (token !== state.playbackToken) return;
                        console.error('[playback] AVPlay error', {
                            channel: ch.name,
                            url: playbackUrlForLog(ch.url),
                            error: error
                        });
                        failPlayback('Unable to connect to this channel');
                    },
                    onevent: function (eventType, eventData) {
                        playbackLog('event', ch, eventType + (eventData ? ': ' + eventData : ''));
                    }
                });
                avplay.prepareAsync(function () {
                    if (token !== state.playbackToken) return;
                    clearPlaybackTimeout();
                    playbackLog('prepared', ch);
                    avplay.play();
                    updatePlayPauseButton();
                    startDvrMonitoring();
                }, function (error) {
                    if (token !== state.playbackToken) return;
                    clearPlaybackTimeout();
                    console.error('[playback] AVPlay prepare failed', {
                        channel: ch.name,
                        url: playbackUrlForLog(ch.url),
                        error: error
                    });
                    failPlayback('This stream format may not be supported');
                });
                state.playbackTimeoutId = setTimeout(function () {
                    if (token !== state.playbackToken) return;
                    console.error('[playback] AVPlay timed out', {
                        channel: ch.name,
                        url: playbackUrlForLog(ch.url)
                    });
                    failPlayback('Playback timed out; try again');
                }, PLAYBACK_TIMEOUT_MS);
            } catch (error) {
                console.error('[playback] AVPlay setup failed', error);
                showToast('Unable to play this channel');
                stopPlayback();
            }
        } else if (window.Hls && window.Hls.isSupported()) {
            state.playerMode = 'hls.js';
            videoPlayer.style.display = '';
            playbackLog('load', ch);
            state.hls = new window.Hls();
            state.hls.loadSource(ch.url);
            state.hls.attachMedia(videoPlayer);
            state.hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
                videoPlayer.play().catch(function (error) {
                    console.error('[playback] browser play failed', error);
                    showToast('Unable to start playback');
                });
            });
            state.hls.on(window.Hls.Events.ERROR, function (event, data) {
                console.error('HLS.js error:', data);
                if (!data.fatal) return;
                if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) state.hls.startLoad();
                else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) state.hls.recoverMediaError();
                else showToast('This stream format may not be supported');
            });
        } else if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
            state.playerMode = 'native-video';
            videoPlayer.style.display = '';
            playbackLog('load', ch);
            videoPlayer.src = ch.url;
            videoPlayer.addEventListener('loadedmetadata', function () {
                videoPlayer.play().catch(function (error) {
                    console.error('[playback] native video play failed', error);
                    showToast('Unable to start playback');
                });
            }, { once: true });
        } else {
            showToast('This device does not support this stream');
        }

        showOverlay();
    }

    function updateFavoriteButton() {
        var btn = document.getElementById('favoriteBtn');
        var icon = document.getElementById('favoriteIcon');
        if (!state.nowPlaying) return;
        var fav = isFavorited(state.nowPlaying);
        icon.textContent = fav ? '\u2605' : '\u2606';
        btn.classList.toggle('active', fav);
    }

    document.getElementById('favoriteBtn').addEventListener('click', function () {
        toggleFavorite(state.nowPlaying);
    });

    document.getElementById('rewindBtn').addEventListener('click', function () {
        seekPlayback(-SEEK_STEPS_MS[state.seekStepIndex]);
    });

    document.getElementById('fastForwardBtn').addEventListener('click', function () {
        seekPlayback(SEEK_STEPS_MS[state.seekStepIndex]);
    });

    document.getElementById('goLiveBtn').addEventListener('click', goLive);

    document.getElementById('seekStepBtn').addEventListener('click', function () {
        state.seekStepIndex = (state.seekStepIndex + 1) % SEEK_STEPS_MS.length;
        document.getElementById('seekStepLabel').textContent = 'Step ' + SEEK_STEP_LABELS[state.seekStepIndex];
        showToast('Seek step: ' + SEEK_STEP_LABELS[state.seekStepIndex]);
        showOverlay();
    });

    document.getElementById('timelineBtn').addEventListener('click', function (event) {
        if (!state.dvr.available || !state.dvr.liveEdgeMs) return;
        var rect = event.currentTarget.getBoundingClientRect();
        var ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        var targetMs = state.dvr.earliestMs + ratio * (state.dvr.liveEdgeMs - state.dvr.earliestMs);
        seekPlayback(targetMs - state.dvr.positionMs);
    });

    document.getElementById('playPauseBtn').addEventListener('click', function () {
        togglePlayPause();
    });

    Focus.zones.playerControls = {
        getMatrix: function () {
            return [[
                document.getElementById('rewindBtn'),
                document.getElementById('fastForwardBtn'),
                document.getElementById('playPauseBtn'),
                document.getElementById('goLiveBtn'),
                document.getElementById('seekStepBtn'),
                document.getElementById('favoriteBtn')
            ], [document.getElementById('timelineBtn')]];
        },
        onEdge: function (dir) {
            if (dir === 'down' && Focus.row === 0) Focus.setZone('playerControls', 1, 0);
            if (dir === 'up' && Focus.row === 1) Focus.setZone('playerControls', 0, 0);
        }
    };

    function showOverlay() {
        var overlay = document.getElementById('playerOverlay');
        overlay.classList.add('visible');
        Focus.setZone('playerControls', 0, 0);
        if (state.overlayTimeoutId) clearTimeout(state.overlayTimeoutId);
        state.overlayTimeoutId = setTimeout(function () { overlay.classList.remove('visible'); }, OVERLAY_HIDE_MS);
    }

    function togglePlayPause() {
        if (state.playerMode === 'AVPlay' && state.avplay) {
            try {
                if (state.avplay.getState() === 'PLAYING') state.avplay.pause();
                else state.avplay.play();
            } catch (error) {
                console.error('[playback] AVPlay pause/play failed', error);
            }
        } else if (videoPlayer.paused) videoPlayer.play(); else videoPlayer.pause();
        updatePlayPauseButton();
        showOverlay();
    }

    function updatePlayPauseButton() {
        var icon = document.getElementById('playPauseIcon');
        var label = document.getElementById('playPauseLabel');
        var playing = false;
        try {
            playing = state.playerMode === 'AVPlay' && state.avplay ?
                state.avplay.getState() === 'PLAYING' : !videoPlayer.paused;
        } catch (error) {
            playing = false;
        }
        icon.textContent = playing ? '\u275A\u275A' : '\u25B6';
        label.textContent = playing ? 'Pause' : 'Play';
    }

    function clearPlaybackTimeout() {
        if (state.playbackTimeoutId) {
            clearTimeout(state.playbackTimeoutId);
            state.playbackTimeoutId = null;
        }
    }

    function stopPlayback() {
        state.playbackToken++;
        clearPlaybackTimeout();
        resetDvrState();
        if (state.hls) { state.hls.destroy(); state.hls = null; }
        if (state.avplay) {
            try {
                var avplayState = state.avplay.getState();
                if (avplayState === 'PREPARED' || avplayState === 'PLAYING' || avplayState === 'PAUSED') {
                    state.avplay.stop();
                }
            } catch (error) {
                console.error('[playback] AVPlay stop failed', error);
            }
            try {
                state.avplay.close();
            } catch (error) {
                console.error('[playback] AVPlay close failed', error);
            }
            state.avplay = null;
        }
        state.playerMode = null;
        document.getElementById('screen-player').classList.remove('avplay-active');
        document.getElementById('avplayObject').style.display = 'none';
        videoPlayer.style.display = '';
        videoPlayer.pause();
        videoPlayer.removeAttribute('src');
        videoPlayer.load();
    }

    function exitPlayerToGrid() {
        stopPlayback();
        var returnScreen = state.previousScreen || 'screen-grid';
        if (returnScreen === 'screen-category-channels') {
            showScreen(returnScreen);
            document.getElementById('navCategories').classList.add('active');
            Focus.setZone('categoryChannelsGrid', 0, 0);
        } else {
            switchToScreen(returnScreen);
        }
    }

    // ==========================================================================
    // Back handling
    // ==========================================================================
    function handleBack() {
        if (!document.getElementById('confirmModal').hidden) { hideConfirm(); return; }
        if (document.getElementById('screen-player').classList.contains('active')) { exitPlayerToGrid(); return; }
        if (document.getElementById('screen-category-channels').classList.contains('active')) { switchToScreen('screen-categories'); return; }
        if (document.getElementById('screen-add').classList.contains('active')) {
            switchToScreen(editingPlaylistId ? 'screen-settings' : 'screen-grid');
            return;
        }
        if (document.getElementById('screen-settings').classList.contains('active')) { switchToScreen('screen-grid'); return; }
        if (document.getElementById('screen-donate').classList.contains('active')) { switchToScreen('screen-grid'); return; }
        if (document.getElementById('screen-my-channels').classList.contains('active')) { switchToScreen('screen-grid'); return; }
        if (document.getElementById('screen-categories').classList.contains('active')) { switchToScreen('screen-grid'); return; }
        showConfirm('Are you sure you want to exit the app?', 'Exit', function () {
            tizen.application.getCurrentApplication().exit();
        });
    }

    // ==========================================================================
    // Global remote-control key handling — keyCode only. Samsung's own docs
    // and every real Tizen sample use keyCode; this platform's WebKit does not
    // reliably populate the modern event.key/event.repeat properties.
    // ==========================================================================
    var KEYCODE = {
        LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 10009,
        CH_UP: 427, CH_DOWN: 428, MEDIA_REWIND: 412,
        MEDIA_FAST_FORWARD: 417, MEDIA_PLAY_PAUSE: 10252
    };

    document.addEventListener('keydown', function (event) {
        var onPlayer = document.getElementById('screen-player').classList.contains('active');

        if (onPlayer) {
            var overlay = document.getElementById('playerOverlay');
            if (overlay.classList.contains('visible') && state.overlayTimeoutId) {
                clearTimeout(state.overlayTimeoutId);
                state.overlayTimeoutId = setTimeout(function () { overlay.classList.remove('visible'); }, OVERLAY_HIDE_MS);
            }
        }

        var keyCode = event.keyCode;
        if (event.key === 'Back') keyCode = KEYCODE.BACK;
        if (event.key === 'MediaPlayPause') keyCode = KEYCODE.MEDIA_PLAY_PAUSE;
        if (event.key === 'ChannelUp') keyCode = KEYCODE.CH_UP;
        if (event.key === 'ChannelDown') keyCode = KEYCODE.CH_DOWN;
        if (event.key === 'MediaRewind') keyCode = KEYCODE.MEDIA_REWIND;
        if (event.key === 'MediaFastForward') keyCode = KEYCODE.MEDIA_FAST_FORWARD;

        switch (keyCode) {
            case KEYCODE.UP: Focus.move('up'); break;
            case KEYCODE.DOWN: Focus.move('down'); break;
            case KEYCODE.LEFT:
                if (onPlayer && Focus.currentZone === 'playerControls' && Focus.row === 1) seekPlayback(-SEEK_STEPS_MS[state.seekStepIndex]);
                else Focus.move('left');
                break;
            case KEYCODE.RIGHT:
                if (onPlayer && Focus.currentZone === 'playerControls' && Focus.row === 1) seekPlayback(SEEK_STEPS_MS[state.seekStepIndex]);
                else Focus.move('right');
                break;
            case KEYCODE.ENTER: Focus.select(); break;
            case KEYCODE.BACK: handleBack(); break;
            case KEYCODE.CH_UP: if (onPlayer) zapChannel(1); break;
            case KEYCODE.CH_DOWN: if (onPlayer) zapChannel(-1); break;
            case KEYCODE.MEDIA_PLAY_PAUSE: if (onPlayer) togglePlayPause(); break;
            case KEYCODE.MEDIA_REWIND: if (onPlayer) seekPlayback(-SEEK_STEPS_MS[state.seekStepIndex]); break;
            case KEYCODE.MEDIA_FAST_FORWARD: if (onPlayer) seekPlayback(SEEK_STEPS_MS[state.seekStepIndex]); break;
        }
        if (keyCode === KEYCODE.BACK || keyCode === KEYCODE.CH_UP ||
            keyCode === KEYCODE.CH_DOWN || keyCode === KEYCODE.MEDIA_PLAY_PAUSE ||
            keyCode === KEYCODE.MEDIA_REWIND || keyCode === KEYCODE.MEDIA_FAST_FORWARD) {
            event.preventDefault();
        }
    });

    // ==========================================================================
    // Boot
    // ==========================================================================
    buildKeyboard();
    loadFavorites();
    loadPlaylistsFromStorage();

    refreshActiveChannels({ screen: 'screen-grid' });

    Focus.setZone('iconRail', 0, 0);
});