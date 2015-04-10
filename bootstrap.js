/* This Source Code Form is subject to the terms of the Mozilla Public
* License, v. 2.0. If a copy of the MPL was not distributed with this file,
* You can obtain one at http://mozilla.org/MPL/2.0/. */

let debug = false;
const MY_STATUS_PREF_BRANCH = "extensions.mystatus.";
const RADIO_GNU_PREF_BRANCH = "extensions.radiognu.";

let {interfaces: Ci, utils: Cu, classes: Cc} = Components;

Cu.import("resource:///modules/imXPCOMUtils.jsm");
Cu.import("resource:///modules/imServices.jsm");
Cu.import("resource://gre/modules/Http.jsm");
Components.utils.importGlobalProperties(["atob"]);
XPCOMUtils.defineLazyModuleGetter(this, "OS", "resource://gre/modules/osfile.jsm");

let timer = Cc["@mozilla.org/timer;1"]
                     .createInstance(Ci.nsITimer);
let mObserver = {
  observe: function(subject, topic, data) {
    if (radiognu.enableStatus) {
      radiognu.now();
    }else{
      timer.cancel();
      myStatus.restore();
    }
  }
}

let myStatus = {
  LOG: function(aMsg) {
    if (debug)
      Services.console.logStringMessage(aMsg);
  },  
  ERROR: function(aMsg) {
    Cu.reportError(aMsg)
  },
  _prefs: Services.prefs.getBranch(MY_STATUS_PREF_BRANCH),
  _currentType: 0,
  _currentStatus: "",
  loaded: false,
  lock: false,
  statusMessageChange: function ms_statusMessageChange() {
    let newStatus = Services.core.globalUserStatus.statusText;
    let newType = Services.core.globalUserStatus.statusType;
    this.updateSavedStatus(newType, newStatus);
  },
  updateSavedStatus: function ms_updateSavedStatus(newType, newStatus) {
    if (newStatus.indexOf("\u266b") > -1)
      return;
    if (this._currentStatus != newStatus || this._currentType != newType) {
      this._prefs.setIntPref("type", newType);
      this._prefs.setCharPref("value", newStatus);
      this._currentType = newType;
      this._currentStatus = newStatus;
    }
  },
  observe: function(aSubject, aTopic, aMsg) {
    if (aTopic == "status-changed" /* #1 < */ || aTopic == "account-connected" /* > */)
	  this.statusMessageChange();
  },
  load: function() {
    this.loaded = true;
    this._currentType = this._prefs.prefHasUserValue("type") ? 
                        this._prefs.getIntPref("type") : 0;
    this._currentStatus = this._prefs.prefHasUserValue("value") ?
                          this._prefs.getCharPref("value") : "";
    if (this._currentType < 0 || this._currentType > 7) {
      this._currentType = 0;
      this._currentStatus = "";
    }
    try {
      Services.core.globalUserStatus.setStatus(this._currentType, this._currentStatus);
    } catch (e) {}
    Services.obs.addObserver(myStatus, "status-changed", false);
    Services.obs.addObserver(myStatus, "account-connected", false);   // possible fix ref. #1
	},
  restore: function() {
    Services.core.globalUserStatus.setStatus(this._currentType, this._currentStatus);
  },
  setStatus: function(aStatus) {
    radiognu.LOG(aStatus);
    Services.core.globalUserStatus.setStatus(
            Services.core.globalUserStatus.statusType, aStatus);
  }
};


let radiognu = {
  LOG: function(aMsg) {
    if (debug)
      Services.console.logStringMessage(aMsg);
  },  
  ERROR: function(aMsg) {
    Cu.reportError(aMsg)
  },
  _prefs: Services.prefs.getBranch(RADIO_GNU_PREF_BRANCH),
  get enableStatus () {
    if (this._prefs.prefHasUserValue("status.enable"))
      if (this._prefs.getBoolPref("status.enable") != "")
        return this._prefs.getBoolPref("status.enable")
    return null;
  },
  get enableAlbumArt () {
    if (this._prefs.prefHasUserValue("cover.enable"))
      if (this._prefs.getBoolPref("cover.enable") != "")
        return this._prefs.getBoolPref("cover.enable")
    return null;
  },
  now: function() {
    let options = {
      postData: null,
      onLoad: null,
      onError: this.ERROR.bind(this),
      logger: {log: this.LOG.bind(this),
               debug: this.LOG.bind(this)}
    }
    let url = "http://www.radiognu.org/api/"
/* {
  "artist": "DJ Spooky",
  "title": "Arctic Rhythms (Dubstep Mix)",
  "album": "Of Water and Ice",
  "id": "1018",
  "cover": "",
  "genre": "",
  "country": "USA",
  "year": "2013",
  "url": "",
  "duration": "273.66022675737",
  "license": {
    "url": "http:\/\/creativecommons.org\/licenses\/by-nc-sa\/3.0\/",
    "name": "Creative Commons Atribuci\u00f3n-NoComercial-CompartirIgual 3.0 Unported",
    "shortname": "CC BY-NC-SA 3.0"
  },
  "listeners": 21,
  "isLive": false
} */
    var artist, title;
    timer.initWithCallback((function () {
      try {
        let ajax = httpRequest(url, options);
        ajax.onload = function (aRequest) {
          let api = JSON.parse(aRequest.target.responseText);
          if(artist != api.artist || title != api.title){
            myStatus.setStatus("\u266b " + api.title + ' - ' + api.artist + " \u266a");
            if (radiognu.enableAlbumArt) {
              var newName = OS.Path.join(OS.Constants.Path.tmpDir, "tmpUserIcon.png");
              var str = api.cover.replace(/^.*?;base64,/, "");
              // Decode to a byte string
              str = atob(str);
              // Decode to an Uint8Array, because OS.File.writeAtomic expects an ArrayBuffer(View).
              var data = new Uint8Array(str.length);
              for (var i = 0, e = str.length; i < e; ++i) {
                data[i] = str.charCodeAt(i);
              }
              var promised = OS.File.writeAtomic(newName, data);
              promised.then(
                function() {
                  let userIconFile = Cc["@mozilla.org/file/local;1"]
                                       .createInstance(Ci.nsILocalFile);
                  userIconFile.initWithPath(newName);
                  Services.core.globalUserStatus.setUserIcon(userIconFile);
                  userIconFile.remove(newName);
                },
                function(ex) {
                  // Failed. Error information in ex
                }
              );
            }
            title = api.title;
            artist = api.artist;
          }
        }
      } catch (e) {
        timer.cancel();
        this.ERROR(e);
      }
    }).bind(this), 2000, timer.TYPE_REPEATING_SLACK);
  }
}

function startup(aData, aReason) {
  Services.obs.addObserver(mObserver, "addon-options-hidden", false);
  myStatus.lock = false;
  if (radiognu.enableStatus) {
    setTimeout((function() {
      myStatus.load();
      radiognu.now();
    }).bind(this), 1000);
  }

}

function shutdown(aData, aReason) {
  try {
    Services.obs.removeObserver(mObserver, "addon-options-hidden");
    if (myStatus.loaded) {
      myStatus.lock = true;
      myStatus.restore();
      Services.obs.removeObserver(myStatus, "status-changed");
      Services.obs.removeObserver(myStatus, "account-connected");
    }
    timer.cancel();
  } catch (e){
    
  }
}

function install(aData, aReason) {
}

function uninstall(aData, aReason) {
  Services.prefs.deleteBranch(RADIO_GNU_PREF_BRANCH),
  Services.prefs.deleteBranch(MY_STATUS_PREF_BRANCH),
  delete timer;
  delete mObserver;
  delete radiognu;
  delete myStatus;
  delete debug;
}