/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global BrowserDialog */
/* global ERROR_DIALOG_CLOSED_BY_USER */
/* global ERROR_INVALID_SYNC_ACCOUNT */
/* global ERROR_OFFLINE */
/* global ERROR_UNKNOWN */
/* global LazyLoader */
/* global Settings */
/* global SettingsListener */
/* global SyncManagerBridge */

'use strict';

(function(exports) {
  const DEBUG = false;
  function debug() {
    if (DEBUG) {
      console.log('[FirefoxSyncSettings] ' + Array.slice(arguments).concat());
    }
  }

  // Screens
  const ENABLED = 'enabled';
  const DISABLED = 'disabled';

  const BOOKMARKS_SETTING = 'sync.collections.bookmarks.enabled';
  const HISTORY_SETTING = 'sync.collections.history.enabled';

  const ELEMENTS = [{
    screen: DISABLED,
    selector: '#fxsync-sign-in-button',
    event: 'mouseup',
    listener: 'enable'
  }, {
    screen: ENABLED,
    selector: '#fxsync-signed-in-as'
  }, {
    screen: ENABLED,
    selector: '#fxsync-sync-now-button',
    event: 'mouseup',
    listener: 'sync'
  }, {
    screen: ENABLED,
    selector: '#fxsync-sign-out-button',
    event: 'mouseup',
    listener: 'disable'
  }, {
    screen: ENABLED,
    selector: '#fxsync-collection-bookmarks',
    event: 'click',
    listener: 'onbookmarkschecked',
    init: 'onbookmarkschange'
  }, {
    screen: ENABLED,
    selector: '#fxsync-collection-history',
    event: 'click',
    listener: 'onhistorychecked',
    init: 'onhistorychange'
  }];

  function getElementName(str) {
    str = str.toLowerCase().replace('#fxsync-', '');
    return str.replace(/-([a-z])/g, g => {
      return g[1].toUpperCase();
    });
  }

  var FirefoxSyncSettings = {
    init() {
      this.area = document.querySelector('#fxsync-area');
      this.elements = {
        enabled: this.area.querySelector('#fxsync-enabled'),
        disabled: this.area.querySelector('#fxsync-disabled')
      };
      this.listeners = new Map();
      this.collections = new Map();
      this.screen = null;
      this.state = null;

      LazyLoader.load('shared/js/settings_listener.js').then(() => {
        [{
          name: BOOKMARKS_SETTING,
          onchange: 'onbookmarkschange'
        }, {
          name: HISTORY_SETTING,
          onchange: 'onhistorychange'
        }].forEach(setting => {
          SettingsListener.observe(setting.name, true, enabled => {
            enabled ? this.collections.set(setting.name, enabled)
                    : this.collections.delete(setting.name);
            this[setting.onchange]();
            this.maybeEnableSyncNow();
          });
        });
      });

      SyncManagerBridge.addListener(this.onsyncchange.bind(this));

      document.addEventListener('visibilitychange', () => {
        debug('Visibility change', document.hidden);
        if (!document.hidden) {
          this.refresh();
        }
      });

      this.refresh();
    },

    refresh() {
      SyncManagerBridge.getInfo().then(this.onsyncchange.bind(this));
    },

    /**
     * This is where most part of the Sync settings logic lives.
     *
     * Here we handle Sync lifecycle events coming from the SyncManager
     * through the SyncMangerBridge. We react to these events by
     * changing the screen depending on the state.
     *
     * We show two possible different state:
     *   1. Logged out screen. We simply show the user what Sync is and
     *      allow her to start using it or to keep walking.
     *   2. Logged in screen. We show to the user several different options:
     *     + The user owning the Sync account. If the account belongs to a
     *     verified user that previosly used Sync, we are fine, if not, we
     *     show a warning asking the user to go to other Firefox client to
     *     create a FxA and login into Sync.
     *     + A button to disable sync. Clicking it will log the user out from
     *     FxA and will clear the synchronized data.
     *     + A button to start a sync on demand. Clicking it will disable the
     *     button and the collections switches while the synchronization is
     *     being performed. Once the sync is done successfully, we enable
     *     all the options back and refresh the last sync time.
     *     We disable this button if no collection is selected.
     *     + Collections switches. Allow the user to select which collections
     *     she wants to keep synchronized. If no collection is selected, the
     *     synchronization will be disabled.
     *     + ToS and Privacy links.
     */

    onsyncchange(message) {
      debug(JSON.stringify(message));
      if (!message || !message.state) {
        throw new Error('Missing sync state');
      }
      switch (message.state) {
        case 'disabled':
          this.showScreen(DISABLED);
          break;
        case 'enabled':
          // We want to show the settings page once Sync is enabled
          // but we only want to do that if its enabled via user action
          // (and not because it is already enabled from a previous run).
          if (this.state === 'enabling') {
            Settings.show();
          }
          this.showScreen(ENABLED);
          this.showUser(message.user);
          this.showSyncNow();
          break;
        case 'syncing':
          this.showScreen(ENABLED);
          this.showSyncing();
          break;
        case 'errored':
          LazyLoader.load('shared/js/sync/errors.js', () => {
            const IGNORED_ERRORS = [
              ERROR_DIALOG_CLOSED_BY_USER
            ];

            if (IGNORED_ERRORS.indexOf(message.error) > -1) {
              return;
            }

            var errorIds = [ERROR_UNKNOWN];

            const KNOWN_ERRORS = [
              ERROR_INVALID_SYNC_ACCOUNT,
              ERROR_OFFLINE
            ];

            if (KNOWN_ERRORS.indexOf(message.error) > -1) {
              errorIds[0] = message.error;
              errorIds[1] = message.error + '-explanation';
            }

            var l10n = navigator.mozL10n;
            Promise.all(
              errorIds.map(l10n.formatValue.bind(l10n))
            ).then(result => {
              window.alert(result[0] + '\n' + result[1], () => {
                this.showScreen(DISABLED);
              });
            });
          });
          break;
      }
      this.state = message.state;
    },

    onbookmarkschange() {
      if (!this.elements.collectionBookmarks) {
        return;
      }
      this.elements.collectionBookmarks.checked =
        this.collections.has(BOOKMARKS_SETTING);
    },

    onbookmarkschecked() {
      var checked = this.elements.collectionBookmarks.checked;
      checked ? this.collections.set(BOOKMARKS_SETTING, true)
              : this.collections.delete(BOOKMARKS_SETTING);
      navigator.mozSettings.createLock().set({
        'sync.collections.bookmarks.enabled': checked
      });
    },

    onhistorychange() {
      if (!this.elements.collectionBookmarks) {
        return;
      }
      this.elements.collectionHistory.checked =
        this.collections.has(HISTORY_SETTING);
    },

    onhistorychecked() {
      var checked = this.elements.collectionHistory.checked;
      if (!checked) {
        this.collections.delete(HISTORY_SETTING);
        navigator.mozSettings.createLock().set({
          'sync.collections.history.enabled': checked
        });
        return;
      }

      try {
        navigator.mozId.watch({
          wantIssuer: 'firefox-accounts',
          onlogin: () => {
            this.collections.set(HISTORY_SETTING, true);
            navigator.mozSettings.createLock().set({
              'sync.collections.history.enabled': checked
            });
          },
          onlogout: () => {},
          onready: () => {},
          onerror: error => {
            console.error(error);
          }
        });
      } catch(e) {}

      navigator.mozId.request({
        oncancel: () => {},
        // We keep authenticated sessions of 5 minutes, if the user clicks on
        // the history collection switch after the 5 minutes are expired, we
        // will be asking her to re-enter her fxa password.
        refreshAuthentication: 5 * 60
      });
    },

    addListener(element, event, listenerName) {
      if (!element || !event || !listenerName) {
        return;
      }
      // Because we bind this to the listener, we need to save
      // the reference so we can remove it afterwards.
      var listener = this[listenerName].bind(this);
      element.addEventListener(event, listener);
      return listener;
    },

    removeListener(element, event, listener) {
      if (!element || !event || !listener) {
        return;
      }
      element.removeEventListener(event, listener);
    },

    loadElements(screen) {
      ELEMENTS.forEach(element => {
        var name = getElementName(element.selector);
        if (element.screen == screen) {
          this.elements[name] = this.area.querySelector(element.selector);
          this.listeners.set(
            name,
            this.addListener(this.elements[name],
                             element.event, element.listener)
          );
          if (element.init) {
            this[element.init]();
          }
          return;
        }

        if (!this.listeners.has(name)) {
          return;
        }
        this.removeListener(this.elements[name],
                            element.event, this.listeners.get(name));
        this.listeners.delete(name);
        this.elements[name] = null;
      });
    },

    showScreen(screen) {
      if (this.screen == screen) {
        return;
      }
      this.screen = screen;

      this.loadElements(screen);

      this.elements.enabled.hidden = (screen != ENABLED);
      this.elements.disabled.hidden = (screen != DISABLED);
    },

    showUser(user) {
      navigator.mozL10n.setAttributes(this.elements.signedInAs,
                                      'fxsync-signed-in-as', {
        email: user
      });
    },

    maybeEnableSyncNow() {
      if (!this.elements.syncNowButton) {
        return;
      }
      (this.collections.size <= 0) ?
        this.elements.syncNowButton.classList.add('disabled') :
        this.elements.syncNowButton.classList.remove('disabled');
    },

    disableSyncNowAndCollections(disabled) {
      ['collectionBookmarks',
       'collectionHistory'].forEach(name => {
        this.elements[name].disabled = disabled;
      });
      disabled ? this.elements.syncNowButton.classList.add('disabled')
               : this.elements.syncNowButton.classList.remove('disabled');
    },

    showSyncNow() {
      this.elements.syncNowButton.dataset.l10nId = 'fxsync-sync-now';
      this.disableSyncNowAndCollections(false);
      this.maybeEnableSyncNow();
    },

    showSyncing() {
      this.elements.syncNowButton.dataset.l10nId = 'fxsync-syncing';
      this.disableSyncNowAndCollections(true);
    },

    enable() {
      SyncManagerBridge.enable();
    },

    disable() {
      BrowserDialog.createDialog('signout_confirm').then(() => {
        SyncManagerBridge.disable();
      });
    },

    sync() {
      SyncManagerBridge.sync();
    }
  };

  exports.FirefoxSyncSettings = FirefoxSyncSettings;

  LazyLoader.load('js/sync/manager_bridge.js', () => {
    FirefoxSyncSettings.init();
  });
}(window));
