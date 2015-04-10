/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const {classes: Cc, interfaces: Ci, results: Cr, utils: Cu} = Components;

Cu.import("resource:///modules/imXPCOMUtils.jsm");
Cu.import("resource:///modules/imServices.jsm");
Cu.import("resource:///modules/ircUtils.jsm");
Cu.import("resource:///modules/ircHandlers.jsm");
Cu.import("resource:///modules/jsProtoHelper.jsm");
Cu.import("resource:///modules/socket.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "PluralForm",
  "resource://gre/modules/PluralForm.jsm");

XPCOMUtils.defineLazyModuleGetter(this, "DownloadUtils",
  "resource://gre/modules/DownloadUtils.jsm");

/*
 * Parses a raw IRC message into an object (see section 2.3 of RFC 2812). This
 * returns an object with the following fields:
 *   rawMessage The initial message string received without any processing.
 *   command    A string that is the command or response code.
 *   params     An array of strings for the parameters. The last parameter is
 *              stripped of its : prefix.
 * If the message is from a user:
 *   nickname   The user's nickname.
 *   user       The user's username, note that this can be undefined.
 *   host       The user's hostname, note that this can be undefined.
 *   source     A "nicely" formatted combination of user & host, which is
 *              <user>@<host> or <user> if host is undefined.
 * Otherwise if it's from a server:
 *   servername This is the address of the server as a host (e.g.
 *              irc.mozilla.org) or an IPv4 address (e.g. 1.2.3.4) or IPv6
 *              address (e.g. 3ffe:1900:4545:3:200:f8ff:fe21:67cf).
 */
function radiognuMessage(aData) {
  let message = {rawMessage: aData};
  let temp, prefix;

  // Splits the raw string into four parts (the second is required), the command
  // is required. A raw string looks like:
  //   [":" <prefix> " "] <command> [" " <parameter>]* [":" <last parameter>]
  //     <prefix>: :(<server name> | <nickname> [["!" <user>] "@" <host>])
  //     <command>: /[^ ]+/
  //     <parameter>: /[^ ]+/
  //     <last parameter>: /.+/
  // See http://joshualuckers.nl/2010/01/10/regular-expression-to-match-raw-irc-messages/
  // Note that this expression is slightly more aggressive in matching than RFC
  // 2812 would allow. It allows for empty parameters (besides the last
  // parameter, which can always be empty), by allowing multiple spaces.
  // (This is for compatibility with Unreal's 432 response, which returns an
  // empty first parameter.) It also allows a trailing space after the
  // <parameter>s when no <last parameter> is present (also occurs with Unreal).
  if (!(temp = aData.match(/^(?::([^ ]+) )?([^ ]+)((?: +[^: ][^ ]*)*)? *(?::([\s\S]*))?$/)))
    throw "Couldn't parse message: \"" + aData + "\"";

  // Assume message is from the server if not specified
  prefix = temp[1];
  message.command = temp[2];
  // Space separated parameters. Since we expect a space as the first thing
  // here, we want to ignore the first value (which is empty).
  message.params = temp[3] ? temp[3].split(" ").slice(1) : [];
  // Last parameter can contain spaces or be an empty string.
  if (temp[4] != undefined)
    message.params.push(temp[4]);

  // The source string can be split into multiple parts as:
  //   :(server|nickname[[!user]@host])
  // If the source contains a . or a :, assume it's a server name. See RFC
  // 2812 Section 2.3 definition of servername vs. nickname.
  if (prefix &&
      (temp = prefix.match(/^([^ !@\.:]+)(?:!([^ @]+))?(?:@([^ ]+))?$/))) {
    message.nickname = temp[1];
    message.user = temp[2] || null; // Optional
    message.host = temp[3] || null; // Optional
    if (message.user)
      message.source = message.user + "@" + message.host;
    else
      message.source = message.host; // Note: this can be null!
  }
  else if (prefix)
    message.servername = prefix;

  return message;
}

// This handles a mode change string for both channels and participants. A mode
// change string is of the form:
//   aAddNewMode is true if modes are being added, false otherwise.
//   aNewModes is an array of mode characters.
function _setMode(aAddNewMode, aNewModes) {
  // Check each mode being added/removed.
  for each (let newMode in aNewModes) {
    let index = this._modes.indexOf(newMode);
    // If the mode is in the list of modes and we want to remove it.
    if (index != -1 && !aAddNewMode)
      this._modes.splice(index, 1);
    // If the mode is not in the list of modes and we want to add it.
    else if (index == -1 && aAddNewMode)
      this._modes.push(newMode);
  }
}

// This copies all the properties of aBase to aPrototype (which is expected to
// be the prototype of an object). This is necessary because JavaScript does not
// support multiple inheritance and both conversation objects have a lot of
// shared code (but inherit from objects exposing different XPCOM interfaces).
function copySharedBaseToPrototype(aBase, aPrototype) {
  for (let property in aBase)
    aPrototype[property] = aBase[property];
}

// Properties / methods shared by both radiognuChannel and radiognuConversation.
const GenericIRCConversation = {
  _observedNicks: [],
  // This is set to true after a message is sent to notify the 401
  // ERR_NOSUCHNICK handler to write an error message to the conversation.
  _pendingMessage: false,
  _waitingForNick: false,

  normalizeNick: function(aNick) this._account.normalizeNick(aNick),

  // This will calculate the maximum number of bytes that are left for a message
  // typed by the user by calculate the amount of bytes that would be used by
  // the IRC messaging.
  getMaxMessageLength: function() {
    // Build the shortest possible message that could be sent to other users.
    let baseMessage = ":" + this._account._nickname + this._account.prefix +
                      " " + this._account.buildMessage("PRIVMSG", this.name) +
                      " :\r\n";
    return this._account.maxMessageLength -
           this._account.countBytes(baseMessage);
  },
  sendMsg: function(aMessage) {
    // Split the message by line breaks and send each one individually.
    let messages = aMessage.split(/[\r\n]+/);

    let maxLength = this.getMaxMessageLength();

    // Attempt to smartly split a string into multiple lines (based on the
    // maximum number of characters the message can contain).
    for (let i = 0; i < messages.length; ++i) {
      let message = messages[i];
      let length = this._account.countBytes(message);
      // The message is short enough.
      if (length <= maxLength)
        continue;

      // Find the location of a space before the maximum length.
      let index = message.lastIndexOf(" ", maxLength);

      // Remove the current message and insert the two new ones. If no space was
      // found, cut the first message to the maximum length and start the second
      // message one character after that. If a space was found, exclude it.
      messages.splice(i, 1, message.substr(0, index == -1 ? maxLength : index),
                      message.substr((index + 1) || maxLength));
    }

    // Send each message and display it in the conversation.
    for (let message of messages) {
      if (!message.length)
        return;

      if (!this._account.sendMessage("PRIVMSG", [this.name, message])) {
        this.writeMessage(this._account._currentServerName,
                          _("error.sendMessageFailed"),
                          {error: true, system: true});
        break;
      }

      // Since the server doesn't send us a message back, just assume the
      // message was received and immediately show it.
      this.writeMessage(this._account._nickname, message, {outgoing: true});

      this._pendingMessage = true;
    }
  },
  // IRC doesn't support typing notifications, but it does have a maximum
  // message length.
  sendTyping: function(aString) {
    let longestLineLength =
      Math.max.apply(null, aString.split("\n").map(this._account.countBytes,
                                                   this._account));
    return this.getMaxMessageLength() - longestLineLength;
  },

  requestBuddyInfo: function(aNick) {
    if (!this._observedNicks.length)
      Services.obs.addObserver(this, "user-info-received", false);
    this._observedNicks.push(this.normalizeNick(aNick));
    this._account.requestBuddyInfo(aNick);
  },

  observe: function(aSubject, aTopic, aData) {
    if (aTopic != "user-info-received")
      return;

    let nick = this.normalizeNick(aData);
    let nickIndex = this._observedNicks.indexOf(nick);
    if (nickIndex == -1)
      return;

    // Remove the nick from the list of nicks that are being waited to received.
    this._observedNicks.splice(nickIndex, 1);

    // If this is the last nick, remove the observer.
    if (!this._observedNicks.length)
      Services.obs.removeObserver(this, "user-info-received");

    // If we are waiting for the conversation name, set it.
    let account = this._account;
    if (this._waitingForNick && nick == this.normalizedName) {
      if (hasOwnProperty(account.whoisInformation, nick))
        this.updateNick(account.whoisInformation[nick]["nick"]);
      delete this._waitingForNick;
      return;
    }

    // Otherwise, print the requested whois information.
    let type = {system: true, noLog: true};
    // RFC 2812 errors 401 and 406 result in there being no entry for the nick.
    if (!hasOwnProperty(account.whoisInformation, nick)) {
      this.writeMessage(null, _("message.unknownNick", nick), type);
      return;
    }
    // If the nick is offline, tell the user. In that case, it's WHOWAS info.
    let msgType = "message.whois";
    if ("offline" in account.whoisInformation[nick])
      msgType = "message.whowas";
    let msg = _(msgType, account.whoisInformation[nick]["nick"]);

    // Iterate over each field.
    let tooltipInfo = aSubject.QueryInterface(Ci.nsISimpleEnumerator);
    while (tooltipInfo.hasMoreElements()) {
      let elt = tooltipInfo.getNext().QueryInterface(Ci.prplITooltipInfo);
      switch (elt.type) {
        case Ci.prplITooltipInfo.pair:
        case Ci.prplITooltipInfo.sectionHeader:
          msg += "\n" + _("message.whoisEntry", elt.label, elt.value);
          break;
        case Ci.prplITooltipInfo.sectionBreak:
          break;
        case Ci.prplITooltipInfo.status:
          if (elt.label != Ci.imIStatusInfo.STATUS_AWAY)
            break;
          // The away message has no tooltipInfo.pair entry.
          msg += "\n" + _("message.whoisEntry", _("tooltip.away"), elt.value);
          break;
      }
    }
    this.writeMessage(null, msg, type);
  },

  unInitIRCConversation: function() {
    this._account.removeConversation(this.name);
    if (this._observedNicks.length)
      Services.obs.removeObserver(this, "user-info-received");
  }
};

function radiognuChannel(aAccount, aName, aNick) {
  this._init(aAccount, aName, aNick);
  this._modes = [];
  this._observedNicks = [];
  this.banMasks = [];
  this._firstJoin = true;
}
radiognuChannel.prototype = {
  __proto__: GenericConvChatPrototype,
  _modes: [],
  _receivedInitialMode: false,
  // For IRC you're not in a channel until the JOIN command is received, open
  // all channels (initially) as left.
  _left: true,
  // True until successfully joined for the first time.
  _firstJoin: false,
  banMasks: [],

  // Overwrite the writeMessage function to apply CTCP formatting before
  // display.
  writeMessage: function(aWho, aText, aProperties) {
    GenericConvChatPrototype.writeMessage.call(this, aWho,
                                               ctcpFormatToHTML(aText),
                                               aProperties);
  },

  // Stores the prplIChatRoomFieldValues required to join this channel
  // to enable later reconnections. If absent, the MUC will not be reconnected
  // automatically after disconnections.
  _chatRoomFields: null,

  // Section 3.2.2 of RFC 2812.
  part: function(aMessage) {
    let params = [this.name];

    // If a valid message was given, use it as the part message.
    // Otherwise, fall back to the default part message, if it exists.
    let msg = aMessage || this._account.getString("partmsg");
    if (msg)
      params.push(msg);

    this._account.sendMessage("PART", params);

    // Remove reconnection information.
    delete this._chatRoomFields;
  },

  close: function() {
    // Part the room if we're connected.
    if (this._account.connected && !this.left)
      this.part();
    GenericConvChatPrototype.close.call(this);
  },

  unInit: function() {
    this.unInitIRCConversation();
    GenericConvChatPrototype.unInit.call(this);
  },

  // Use the normalized nick in order to properly notify the observers.
  getNormalizedChatBuddyName: function(aNick) this.normalizeNick(aNick),

  hasParticipant: function(aNick)
    hasOwnProperty(this._participants, this.normalizeNick(aNick)),

  getParticipant: function(aNick, aNotifyObservers) {
    let normalizedNick = this.normalizeNick(aNick);
    if (this.hasParticipant(aNick))
      return this._participants[normalizedNick];

    let participant = new radiognuParticipant(aNick, this);
    this._participants[normalizedNick] = participant;

    // Add the participant to the whois table if it is not already there.
    this._account.setWhois(participant._name);

    if (aNotifyObservers) {
      this.notifyObservers(new nsSimpleEnumerator([participant]),
                           "chat-buddy-add");
    }
    return participant;
  },
  updateNick: function(aOldNick, aNewNick) {
    let isParticipant = this.hasParticipant(aOldNick);
    if (this.normalizeNick(aOldNick) == this.normalizeNick(this.nick)) {
      // If this is the user's nick, change it.
      this.nick = aNewNick;
      // If the account was disconnected, it's OK the user is not a participant.
      if (!isParticipant)
        return;
    }
    else if (!isParticipant) {
      this.ERROR("Trying to rename nick that doesn't exist! " + aOldNick +
                 " to " + aNewNick);
      return;
    }

    // Get the original radiognuParticipant and then remove it.
    let participant = this.getParticipant(aOldNick);
    this.removeParticipant(aOldNick);

    // Update the nickname and add it under the new nick.
    participant._name = aNewNick;
    this._participants[this.normalizeNick(aNewNick)] = participant;

    this.notifyObservers(participant, "chat-buddy-update", aOldNick);
  },
  removeParticipant: function(aNick, aNotifyObservers) {
    if (!this.hasParticipant(aNick))
      return;

    if (aNotifyObservers) {
      let stringNickname = Cc["@mozilla.org/supports-string;1"]
                              .createInstance(Ci.nsISupportsString);
      stringNickname.data = aNick;
      this.notifyObservers(new nsSimpleEnumerator([stringNickname]),
                           "chat-buddy-remove");
    }
    delete this._participants[this.normalizeNick(aNick)];
  },
  // Use this before joining to avoid errors of trying to re-add an existing
  // participant
  removeAllParticipants: function() {
    let stringNicknames = [];
    for (let nickname in this._participants) {
      let stringNickname = Cc["@mozilla.org/supports-string;1"]
                              .createInstance(Ci.nsISupportsString);
      stringNickname.data = this._participants[nickname].name;
      stringNicknames.push(stringNickname);
    }
    this.notifyObservers(new nsSimpleEnumerator(stringNicknames),
                         "chat-buddy-remove");
    this._participants = {};
  },

  setMode: function(aNewMode, aModeParams, aSetter) {
    const hostMaskExp = /^.+!.+@.+$/;
    function getNextParam() {
      // If there's no next parameter, throw a warning.
      if (!aModeParams.length) {
        this.WARN("Mode parameter expected!");
        return undefined;
      }
      return aModeParams.pop();
    }
    function peekNextParam() {
      // Non-destructively gets the next param.
      if (!aModeParams.length)
        return undefined;
      return aModeParams.slice(-1)[0];
    }

    // Are modes being added or removed?
    if (aNewMode[0] != "+" && aNewMode[0] != "-") {
      this.WARN("Invalid mode string: " + aNewMode);
      return;
    }
    let addNewMode = aNewMode[0] == "+";

    // Check each mode being added and update the user.
    let channelModes = [];
    let userModes = {};
    let msg;

    for (let i = aNewMode.length - 1; i > 0; --i) {
      // Since some modes are conflicted between different server
      // implementations, check if a participant with that name exists. If this
      // is true, then update the mode of the ConvChatBuddy.
      if (this._account.memberStatuses.indexOf(aNewMode[i]) != -1 &&
          aModeParams.length && this.hasParticipant(peekNextParam())) {
        // Store the new modes for this nick (so each participant's mode is only
        // updated once).
        let nick = this.normalizeNick(getNextParam());
        if (!hasOwnProperty(userModes, nick))
          userModes[nick] = [];
        userModes[nick].push(aNewMode[i]);

        // Don't use this mode as a channel mode.
        continue;
      }
      else if (aNewMode[i] == "k") {
        // Channel key.
        let newFields = this.name;
        if (addNewMode) {
          let key = getNextParam();
          // A new channel key was set, display a message if this key is not
          // already known.
          if (this._chatRoomFields &&
              this._chatRoomFields.getValue("password") == key) {
            continue;
          }
          msg = _("message.channelKeyAdded", aSetter, key);
          newFields += " " + key;
        }
        else
          msg = _("message.channelKeyRemoved", aSetter);

        this.writeMessage(aSetter, msg, {system: true});
        // Store the new fields for reconnect.
        this._chatRoomFields =
          this._account.getChatRoomDefaultFieldValues(newFields);
      }
      else if (aNewMode[i] == "b") {
        // A banmask was added or removed.
        let banMask = getNextParam();
        let msgKey = "message.banMask";
        if (addNewMode) {
          this.banMasks.push(banMask);
          msgKey += "Added";
        }
        else {
          this.banMasks =
            this.banMasks.filter(function (aBanMask) banMask != aBanMask);
          msgKey += "Removed";
        }
        this.writeMessage(aSetter, _(msgKey, banMask, aSetter), {system: true});
      }
      else if (["e", "I", "l"].indexOf(aNewMode[i]) != -1) {
        // TODO The following have parameters that must be accounted for.
        getNextParam();
      }
      else if (aNewMode[i] == "R" && aModeParams.length &&
               peekNextParam().match(hostMaskExp)) {
        // REOP_LIST takes a mask as a parameter, since R is a conflicted mode,
        // try to match the parameter. Implemented by IRCNet.
        // TODO The parameter must be acounted for.
        getNextParam();
      }
      // TODO From RFC 2811: a, i, m, n, q, p, s, r, t, l, e, I.

      // Keep track of the channel modes in the order they were received.
      channelModes.unshift(aNewMode[i]);
    }

    if (aModeParams.length)
      this.WARN("Unused mode parameters: " + aModeParams.join(", "));

    // Update the mode of each participant.
    for (let nick in userModes)
      this.getParticipant(nick).setMode(addNewMode, userModes[nick], aSetter);

    if (!channelModes.length)
      return;

    // Store the channel modes.
    _setMode.call(this, addNewMode, channelModes);

    // Notify the UI of changes.
    msg = _("message.channelmode", aNewMode[0] + channelModes.join(""),
            aSetter);
    this.writeMessage(aSetter, msg, {system: true});
    this.checkTopicSettable();

    this._receivedInitialMode = true;
  },

  setModesFromRestriction: function(aRestriction) {
    // First remove all types from the list of modes.
    for each (let mode in this._account.channelRestrictionToModeMap) {
      let index = this._modes.indexOf(mode);
      this._modes.splice(index, index != -1);
    }

    // Add the new mode onto the list.
    if (aRestriction in this._account.channelRestrictionToModeMap) {
      let mode = this._account.channelRestrictionToModeMap[aRestriction];
      if (mode)
        this._modes.push(mode);
    }
  },

  get topic() this._topic, // can't add a setter without redefining the getter
  set topic(aTopic) {
    this._account.sendMessage("TOPIC", [this.name, aTopic]);
  },
  _previousTopicSettable: null,
  checkTopicSettable: function() {
    if (this.topicSettable == this._previousTopicSettable &&
        this._previousTopicSettable != null)
      return;

    this.notifyObservers(this, "chat-update-topic");
  },
  get topicSettable() {
    // If we're not in the room yet, we don't exist.
    if (!this.hasParticipant(this.nick))
      return false;

    // If the channel mode is +t, hops and ops can set the topic; otherwise
    // everyone can.
    let participant = this.getParticipant(this.nick);
    return this._modes.indexOf("t") == -1 || participant.op ||
           participant.halfOp;
  }
};
copySharedBaseToPrototype(GenericIRCConversation, radiognuChannel.prototype);

function radiognuParticipant(aName, aConv) {
  this._name = aName;
  this._conv = aConv;
  this._account = aConv._account;
  this._modes = [];

  // Handle multi-prefix modes.
  let i;
  for (i = 0; i < this._name.length &&
              this._name[i] in this._account.userPrefixToModeMap; ++i)
    this._modes.push(this._account.userPrefixToModeMap[this._name[i]]);
  this._name = this._name.slice(i);
}
radiognuParticipant.prototype = {
  __proto__: GenericConvChatBuddyPrototype,

  setMode: function(aAddNewMode, aNewModes, aSetter) {
    _setMode.call(this, aAddNewMode, aNewModes);

    // Notify the UI of changes.
    let msg = _("message.usermode", (aAddNewMode ? "+" : "-") + aNewModes.join(""),
                this.name, aSetter);
    this._conv.writeMessage(aSetter, msg, {system: true});
    this._conv.notifyObservers(this, "chat-buddy-update");

    // In case the new mode now lets us edit the topic.
    if (this._account.normalize(this.name) ==
        this._account.normalize(this._account._nickname))
      this._conv.checkTopicSettable();
  },

  get voiced() this._modes.indexOf("v") != -1,
  get halfOp() this._modes.indexOf("h") != -1,
  get op() this._modes.indexOf("o") != -1,
  get founder()
    this._modes.indexOf("O") != -1 || this._modes.indexOf("q") != -1,
  get typing() false
};

function radiognuConversation(aAccount, aName) {
  let nick = aAccount.normalize(aName);
  if (hasOwnProperty(aAccount.whoisInformation, nick))
    aName = aAccount.whoisInformation[nick]["nick"];

  this._init(aAccount, aName);
  this._observedNicks = [];

  // Fetch correctly capitalized name.
  // Always request the info as it may be out of date.
  this._waitingForNick = true;
  this.requestBuddyInfo(aName);
}
radiognuConversation.prototype = {
  __proto__: GenericConvIMPrototype,
  get buddy() this._account.getBuddy(this.name),

  // Overwrite the writeMessage function to apply CTCP formatting before
  // display.
  writeMessage: function(aWho, aText, aProperties) {
    GenericConvIMPrototype.writeMessage.call(this, aWho,
                                             ctcpFormatToHTML(aText),
                                             aProperties);
  },

  unInit: function() {
    this.unInitIRCConversation();
    GenericConvIMPrototype.unInit.call(this);
  },

  updateNick: function(aNewNick) {
    this._name = aNewNick;
    this.notifyObservers(null, "update-conv-title");
  }
};
copySharedBaseToPrototype(GenericIRCConversation, radiognuConversation.prototype);

function radiognuSocket(aAccount) {
  this._account = aAccount;
  this._initCharsetConverter();
}
radiognuSocket.prototype = {
  __proto__: Socket,
  // Although RFCs 1459 and 2812 explicitly say that \r\n is the message
  // separator, some networks (euIRC) only send \n.
  delimiter: /\r?\n/,
  connectTimeout: 60, // Failure to connect after 1 minute
  readWriteTimeout: 300, // Failure when no data for 5 minutes
  _converter: null,

  sendPing: function() {
    // Send a ping using the current timestamp as a payload prefixed with
    // an underscore to signify this was an "automatic" PING (used to avoid
    // socket timeouts).
    this._account.sendMessage("PING", "_" + Date.now());
  },

  _initCharsetConverter: function() {
    this._converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
                        .createInstance(Ci.nsIScriptableUnicodeConverter);
    try {
      this._converter.charset = this._account._encoding;
    } catch (e) {
      delete this._converter;
      this.ERROR("Failed to set character set to: " + this._account._encoding +
                 " for " + this._account.name + ".");
    }
  },

  // Implement Section 5 of RFC 2812.
  onDataReceived: function(aRawMessage) {
    let conversionWarning = "";
    if (this._converter) {
      try {
        aRawMessage = this._converter.ConvertToUnicode(aRawMessage);
      } catch (e) {
        conversionWarning = "\nThis message doesn't seem to be " +
                            this._account._encoding + " encoded.";
        // Unfortunately, if the unicode converter failed once,
        // it will keep failing so we need to reinitialize it.
        this._initCharsetConverter();
      }
    }

    // We've received data and are past the authentication stage.
    if (this._account.connected)
      this.resetPingTimer();

    // Low level dequote: replace quote character \020 followed by 0, n, r or
    // \020 with a \0, \n, \r or \020, respectively. Any other character is
    // replaced with itself.
    const lowDequote = {"0": "\0", "n": "\n", "r": "\r", "\x10": "\x10"};
    let dequotedMessage = aRawMessage.replace(/\x10./g,
      function(aStr) lowDequote[aStr[1]] || aStr[1]);

    try {
      let message = new radiognuMessage(dequotedMessage);
      this.DEBUG(JSON.stringify(message) + conversionWarning);
      if (!ircHandlers.handleMessage(this._account, message)) {
        // If the message was not handled, throw a warning containing
        // the original quoted message.
        this.WARN("Unhandled IRC message:\n" + aRawMessage);
      }
    } catch (e) {
      // Catch the error, display it and hope the connection can continue with
      // this message in error. Errors are also caught inside of handleMessage,
      // but we expect to handle message parsing errors here.
      this.DEBUG(aRawMessage + conversionWarning);
      this.ERROR(e);
    }
  },
  onConnection: function() {
    this._account._connectionRegistration.call(this._account);
  },
  disconnect: function() {
    if (!this._account)
      return;
    Socket.disconnect.call(this);
    delete this._account;
  },

  // Throw errors if the socket has issues.
  onConnectionClosed: function() {
    // If the account was already disconnected, e.g. in response to
    // onConnectionReset, do nothing.
    if (!this._account)
      return;
    const msg = "Connection closed by server.";
    if (this._account.disconnecting) {
      // The server closed the connection before we handled the ERROR
      // response to QUIT.
      this.LOG(msg);
      this._account.gotDisconnected();
    }
    else {
      this.ERROR(msg);
      this._account.gotDisconnected(Ci.prplIAccount.ERROR_NETWORK_ERROR,
                                    _("connection.error.lost"));
    }
  },
  onConnectionReset: function() {
    this.ERROR("Connection reset.");
    this._account.gotDisconnected(Ci.prplIAccount.ERROR_NETWORK_ERROR,
                                  _("connection.error.lost"));
  },
  onConnectionTimedOut: function() {
    this.ERROR("Connection timed out.");
    this._account.gotDisconnected(Ci.prplIAccount.ERROR_NETWORK_ERROR,
                                  _("connection.error.timeOut"));
  },
  onBadCertificate: function(aIsSslError, aNSSErrorMessage) {
    this.ERROR("Bad certificate or SSL connection for " + this._account.name +
               ":\n" + aNSSErrorMessage);
    let error = this._account.handleBadCertificate(this, aIsSslError);
    this._account.gotDisconnected(error, aNSSErrorMessage);
  },

  get DEBUG() this._account.DEBUG,
  get LOG() this._account.LOG,
  get WARN() this._account.WARN,
  get ERROR() this._account.ERROR
};

function radiognuAccountBuddy(aAccount, aBuddy, aTag, aUserName) {
  this._init(aAccount, aBuddy, aTag, aUserName);
}
radiognuAccountBuddy.prototype = {
  __proto__: GenericAccountBuddyPrototype,

  // Returns a list of imITooltipInfo objects to be displayed when the user
  // hovers over the buddy.
  getTooltipInfo: function() this._account.getBuddyInfo(this.normalizedName),

  // Allow sending of messages to buddies even if they are not online since IRC
  // does not always provide status information in a timely fashion. (Note that
  // this is OK since the server will throw an error if the user is not online.)
  get canSendMessage() this.account.connected,

  // Called when the user wants to chat with the buddy.
  createConversation: function() this._account.createConversation(this.userName),

  remove: function() {
    this._account.removeBuddy(this);
    GenericAccountBuddyPrototype.remove.call(this);
  }
};

function radiognuAccount(aProtocol, aImAccount) {
  this._buddies = {};
  this._init(aProtocol, aImAccount);
  this._conversations = {};

  // Split the account name into usable parts.
  let splitter = this.name.lastIndexOf("@");
  this._accountNickname = this.name.slice(0, splitter);
  this._server = this.name.slice(splitter + 1);

  this._nickname = this._accountNickname;
  this._requestedNickname = this._nickname;

  // For more information, see where these are defined in the prototype below.
  this.trackQueue = [];
  this.pendingIsOnQueue = [];
  this.whoisInformation = {};
  this._chatRoomFieldsList = {};
  this._caps = [];

  this._roomInfoCallbacks = new Set();
}
radiognuAccount.prototype = {
  __proto__: GenericAccountPrototype,
  _socket: null,
  _MODE_WALLOPS: 1 << 2, // mode 'w'
  _MODE_INVISIBLE: 1 << 3, // mode 'i'
  get _mode() 0,

  // The name of the server we last connected to.
  _currentServerName: null,
  // Whether to attempt authenticating with NickServ.
  shouldAuthenticate: true,
  // Whether the user has successfully authenticated with NickServ.
  isAuthenticated: false,
  // The nickname stored in the account name.
  _accountNickname: null,
  // The nickname that will be used when connecting.
  _requestedNickname: null,
  // The prefix minus the nick (!user@host) as returned by the server, this is
  // necessary for guessing message lengths.
  prefix: null,

  // Parts of the specification give max lengths, keep track of them since a
  // server can overwrite them. The defaults given here are from RFC 2812.
  maxNicknameLength: 9, // 1.2.1 Users
  maxChannelLength: 50, // 1.3 Channels
  maxMessageLength: 512, // 2.3 Messages
  maxHostnameLength: 63, // 2.3.1 Message format in Augmented BNF

  // The default prefixes to modes.
  userPrefixToModeMap: {"@": "o", "!": "n", "%": "h", "+": "v"},
  get userPrefixes() Object.keys(this.userPrefixToModeMap),
  // Modes that have a nickname parameter and affect a participant. See 4.1
  // Member Status of RFC 2811.
  memberStatuses: ["a", "h", "o", "O", "q", "v", "!"],
  channelPrefixes: ["&", "#", "+", "!"], // 1.3 Channels
  channelRestrictionToModeMap: {"@": "s", "*": "p", "=": null}, // 353 RPL_NAMREPLY

  // Handle Scandanavian lower case (optionally remove status indicators).
  // See Section 2.2 of RFC 2812: the characters {}|^ are considered to be the
  // lower case equivalents of the characters []\~, respectively.
  normalizeExpression: /[\x41-\x5E]/g,
  normalize: function(aStr, aPrefixes) {
    let str = aStr;

    if (aPrefixes) {
      while (aPrefixes.indexOf(str[0]) != -1)
        str = str.slice(1);
    }

    return str.replace(this.normalizeExpression,
                       function(c) String.fromCharCode(c.charCodeAt(0) + 0x20));
  },
  normalizeNick: function(aNick) this.normalize(aNick, this.userPrefixes),

  isMUCName: function(aStr) {
    return (this.channelPrefixes.indexOf(aStr[0]) != -1);
  },

  // Tell the server about status changes. IRC is only away or not away;
  // consider the away, idle and unavailable status type to be away.
  isAway: false,
  observe: function(aSubject, aTopic, aData) {
    if (aTopic != "status-changed")
      return;

    let {statusType: type, statusText: text} = this.imAccount.statusInfo;
    this.DEBUG("New status received:\ntype = " + type + "\ntext = " + text);

    // Tell the server to mark us as away.
    if (type < Ci.imIStatusInfo.STATUS_AVAILABLE) {
      // We have to have a string in order to set IRC as AWAY.
      if (!text) {
        // If no status is given, use the the default idle/away message.
        const IDLE_PREF_BRANCH = "messenger.status.";
        const IDLE_PREF = "defaultIdleAwayMessage";
        text = Services.prefs.getComplexValue(IDLE_PREF_BRANCH + IDLE_PREF,
                                              Ci.nsIPrefLocalizedString).data;

        if (!text) {
          // Get the default value of the localized preference.
          text = Services.prefs.getDefaultBranch(IDLE_PREF_BRANCH)
                         .getComplexValue(IDLE_PREF,
                                          Ci.nsIPrefLocalizedString).data;
        }
        // The last resort, fallback to a non-localized string.
        if (!text)
          text = "Away";
      }
      this.sendMessage("AWAY", text); // Mark as away.
    }
    else if (type == Ci.imIStatusInfo.STATUS_AVAILABLE && this.isAway)
      this.sendMessage("AWAY"); // Mark as back.
  },

  // The user's user mode.
  _modes: [],
  _userModeReceived: false,
  setUserMode: function(aNick, aNewModes, aSetter, aDisplayFullMode) {
    if (this.normalizeNick(aNick) != this.normalizeNick(this._nickname)) {
      WARN("Received unexpected mode for " + aNick);
      return false;
    }

    // Are modes being added or removed?
    let addNewMode = aNewModes[0] == "+";
    if (!addNewMode && aNewModes[0] != "-") {
      WARN("Invalid mode string: " + aNewModes);
      return false;
    }
    _setMode.call(this, addNewMode, aNewModes.slice(1));

    // The server informs us of the user's mode when connecting.
    // We should not report this initial mode message as a mode change
    // initiated by the user, but instead display the full mode
    // and then remember we have done so.
    this._userModeReceived = true;

    if (this._showServerTab) {
      let msg;
      if (aDisplayFullMode)
        msg = _("message.yourmode", this._modes.join(""));
      else {
        msg = _("message.usermode", aNewModes, aNick,
                aSetter || this._currentServerName);
      }
      this.getConversation(this._currentServerName)
          .writeMessage(this._currentServerName, msg, {system: true});
    }
    return true;
  },

  // Channels are stored as prplIRoomInfo.
  _channelList: [],
  _roomInfoCallbacks: new Set(),
  // If true, we have sent the LIST request and are waiting for replies.
  _pendingList: false,
  // Callbacks receive at most this many channels per call.
  _channelsPerBatch: 25,
  _lastListTime: 0,
  get isRoomInfoStale() Date.now() - this._lastListTime > kListRefreshInterval,
  // Called by consumers that want a list of available channels, which are
  // provided through the callback (prplIRoomInfoCallback instance).
  requestRoomInfo: function(aCallback, aIsUserRequest) {
    // Ignore the automaticList pref if the user explicitly requests /list.
    if (!aIsUserRequest &&
        !Services.prefs.getBoolPref("chat.irc.automaticList"))
      throw Cr.NS_ERROR_NOT_IMPLEMENTED; // Pretend we can't return roomInfo.
    if (this._roomInfoCallbacks.has(aCallback)) // Callback is not new.
      return;
    // Send a LIST request if the channel list is stale and a current request
    // has not been sent.
    if (this.isRoomInfoStale && !this._pendingList) {
      this._channelList = [];
      this._pendingList = true;
      this._lastListTime = Date.now();
      this.sendMessage("LIST");
    }
    // Otherwise, pass channels that have already been received to the callback.
    else {
      aCallback.onRoomInfoAvailable(this._channelList, this, !this._pendingList,
                                    this._channelList.length);
    }

    if (this._pendingList)
      this._roomInfoCallbacks.add(aCallback);
  },
  // Pass room info for any remaining channels to callbacks and clean up.
  _sendRemainingRoomInfo: function() {
    let remainingChannelCount = this._channelList.length % this._channelsPerBatch;
    if (remainingChannelCount) {
      let remainingChannels = this._channelList.slice(-remainingChannelCount);
      for (let callback of this._roomInfoCallbacks) {
        callback.onRoomInfoAvailable(remainingChannels, this, true,
                                     remainingChannelCount);
      }
    }
    this._roomInfoCallbacks.clear();
    delete this._pendingList;
  },

  // The whois information: nicks are used as keys and refer to a map of field
  // to value.
  whoisInformation: {},
  // Request WHOIS information on a buddy when the user requests more
  // information.
  requestBuddyInfo: function(aBuddyName) {
    if (!this.connected)
      return;

    this.removeBuddyInfo(aBuddyName);
    this.sendMessage("WHOIS", aBuddyName);
  },
  notifyWhois: function(aNick) {
    Services.obs.notifyObservers(this.getBuddyInfo(aNick), "user-info-received",
                                 this.normalizeNick(aNick));
  },
  // Request WHOWAS information on a buddy when the user requests more
  // information.
  requestOfflineBuddyInfo: function(aBuddyName) {
    this.removeBuddyInfo(aBuddyName);
    this.sendMessage("WHOWAS", aBuddyName);
  },
  // Return an nsISimpleEnumerator of imITooltipInfo for a given nick.
  getBuddyInfo: function(aNick) {
    let nick = this.normalizeNick(aNick);
    if (!hasOwnProperty(this.whoisInformation, nick))
      return EmptyEnumerator;

    let whoisInformation = this.whoisInformation[nick];
    if (whoisInformation.serverName && whoisInformation.serverInfo) {
      whoisInformation.server =
        _("tooltip.serverValue", whoisInformation.serverName,
          whoisInformation.serverInfo);
    }

    // Sort the list of channels, ignoring the prefixes of channel and user.
    let prefixes = this.userPrefixes.concat(this.channelPrefixes);
    let sortWithoutPrefix = function(a, b) {
      a = this.normalize(a, prefixes);
      b = this.normalize(b, prefixes);
      return a < b ? -1 : a > b ? 1 : 0;
    }.bind(this);
    let sortChannels = function(channels)
      channels.trim().split(/\s+/).sort(sortWithoutPrefix).join(" ");

    // Convert booleans into a human-readable form.
    let normalizeBool = function(aBool) _(aBool ? "yes" : "no");

    // Convert timespan in seconds into a human-readable form.
    let normalizeTime = function(aTime) {
      let valuesAndUnits = DownloadUtils.convertTimeUnits(aTime);
      // If the time is exact to the first set of units, trim off
      // the subsequent zeroes.
      if (!valuesAndUnits[2])
        valuesAndUnits.splice(2, 2);
      return _("tooltip.timespan", valuesAndUnits.join(" "));
    };

    // List of the names of the info to actually show in the tooltip and
    // optionally a transform function to apply to the value. Each field here
    // maps to tooltip.<fieldname> in irc.properties.
    // See the various RPL_WHOIS* results for the options.
    const kFields = {
      realname: null,
      server: null,
      connectedFrom: null,
      registered: normalizeBool,
      registeredAs: null,
      secure: normalizeBool,
      ircOp: normalizeBool,
      bot: normalizeBool,
      lastActivity: normalizeTime,
      channels: sortChannels
    };

    let tooltipInfo = [];
    for (let field in kFields) {
      if (whoisInformation.hasOwnProperty(field) && whoisInformation[field]) {
        let value = whoisInformation[field];
        if (kFields[field])
          value = kFields[field](value);
        tooltipInfo.push(new TooltipInfo(_("tooltip." + field), value));
      }
    }

    const kSetIdleStatusAfterSeconds = 3600;
    let statusType = Ci.imIStatusInfo.STATUS_AVAILABLE;
    let statusText = "";
    if ("away" in whoisInformation) {
      statusType = Ci.imIStatusInfo.STATUS_AWAY;
      statusText = whoisInformation["away"];
    }
    else if ("offline" in whoisInformation)
      statusType = Ci.imIStatusInfo.STATUS_OFFLINE;
    else if ("lastActivity" in whoisInformation &&
             whoisInformation["lastActivity"] > kSetIdleStatusAfterSeconds)
      statusType = Ci.imIStatusInfo.STATUS_IDLE;
    tooltipInfo.push(new TooltipInfo(statusType, statusText, true));

    return new nsSimpleEnumerator(tooltipInfo);
  },
  // Remove a WHOIS entry.
  removeBuddyInfo: function(aNick) {
    let nick = this.normalizeNick(aNick);
    if (hasOwnProperty(this.whoisInformation, nick))
      delete this.whoisInformation[nick];
  },
  // Copies the fields of aFields into the whois table. If the field already
  // exists, that field is ignored (it is assumed that the first server response
  // is the most up to date information, as is the case for 312/314). Note that
  // the whois info for a nick is reset whenever whois information is requested,
  // so the first response from each whois is recorded.
  setWhois: function(aNick, aFields = {}) {
    let nick = this.normalizeNick(aNick);
    // If the nickname isn't in the list yet, add it.
    if (!hasOwnProperty(this.whoisInformation, nick))
      this.whoisInformation[nick] = {};

    // Set non-normalized nickname field.
    this.whoisInformation[nick]["nick"] = aNick;

    // Set the WHOIS fields, but only the first time a field is set.
    for (let field in aFields) {
      if (!this.whoisInformation[nick].hasOwnProperty(field))
        this.whoisInformation[nick][field] = aFields[field];
    }

    return true;
  },

  trackBuddy: function(aNick) {
    // Put the username as the first to be checked on the next ISON call.
    this.trackQueue.unshift(aNick);
  },
  untrackBuddy: function(aNick) {
    let index = this.trackQueue.indexOf(aNick);
    if (index < 0) {
      this.ERROR("Trying to untrack a nick that was not being tracked: "+ aNick);
      return;
    }
    this.trackQueue.splice(index, 1);
  },
  addBuddy: function(aTag, aName) {
    let buddy = new radiognuAccountBuddy(this, null, aTag, aName);
    this._buddies[buddy.normalizedName] = buddy;
    this.trackBuddy(buddy.userName);

    Services.contacts.accountBuddyAdded(buddy);
  },
  removeBuddy: function(aBuddy) {
    delete this._buddies[aBuddy.normalizedName];
    this.untrackBuddy(aBuddy.userName);
  },
  // Loads a buddy from the local storage. Called for each buddy locally stored
  // before connecting to the server.
  loadBuddy: function(aBuddy, aTag) {
    let buddy = new radiognuAccountBuddy(this, aBuddy, aTag);
    this._buddies[buddy.normalizedName] = buddy;
    this.trackBuddy(buddy.userName);

    return buddy;
  },
  hasBuddy: function(aName)
    hasOwnProperty(this._buddies, this.normalizeNick(aName)),
  // Return an array of buddy names.
  getBuddyNames: function() {
    let buddies = [];
    for each (let buddyName in Object.keys(this._buddies))
      buddies.push(this._buddies[buddyName].userName);
    return buddies;
  },
  getBuddy: function(aName) {
    if (this.hasBuddy(aName))
      return this._buddies[this.normalizeNick(aName)];
    return null;
  },
  changeBuddyNick: function(aOldNick, aNewNick) {
    let msg;
    if (this.normalizeNick(aOldNick) == this.normalizeNick(this._nickname)) {
      // Your nickname changed!
      this._nickname = aNewNick;
      msg = _("message.nick.you", aNewNick);
      for each (let conversation in this._conversations) {
        // Update the nick for chats, and inform the user in every conversation.
        if (conversation.isChat)
          conversation.updateNick(aOldNick, aNewNick);
        conversation.writeMessage(aOldNick, msg, {system: true});
      }
    }
    else {
      msg = _("message.nick", aOldNick, aNewNick);
      for each (let conversation in this._conversations) {
        if (conversation.isChat && conversation.hasParticipant(aOldNick)) {
          // Update the nick in every chat conversation it is in.
          conversation.updateNick(aOldNick, aNewNick);
          conversation.writeMessage(aOldNick, msg, {system: true});
        }
      }
    }

    // Adjust the whois table where necessary.
    this.removeBuddyInfo(aOldNick);
    this.setWhois(aNewNick);

    // If a private conversation is open with that user, change its title.
    if (this.hasConversation(aOldNick)) {
      // Get the current conversation and rename it.
      let conversation = this.getConversation(aOldNick);

      // Remove the old reference to the conversation and create a new one.
      this.removeConversation(aOldNick);
      this._conversations[this.normalizeNick(aNewNick)] = conversation;

      conversation.updateNick(aNewNick);
      conversation.writeMessage(aOldNick, msg, {system: true});
    }
  },

  /*
   * Generate a new nick to change to if the user requested nick is already in
   * use or is otherwise invalid.
   *
   * First try all the alternate nicks that were chosen by the user, and if none
   * of them work, then generate a new nick by:
   *  1. If there was not a digit at the end of the nick, append a 1.
   *  2. If there was a digit, then increment the number.
   *  3. Add leading 0s back on.
   *  4. Ensure the nick is an appropriate length.
   */
  tryNewNick: function(aOldNick) {
    // Split the string on commas, remove whitespace around the nicks and
    // remove empty nicks.
    let allNicks = this.getString("alternateNicks").split(",")
                       .map(n => n.trim()).filter(n => !!n);
    allNicks.unshift(this._accountNickname);

    // If the previously tried nick is in the array and not the last
    // element, try the next nick in the array.
    let oldIndex = allNicks.indexOf(aOldNick);
    if (oldIndex != -1 && oldIndex < allNicks.length - 1) {
      let newNick = allNicks[oldIndex + 1];
      this.LOG(aOldNick + " is already in use, trying " + newNick);
      this.sendMessage("NICK", newNick); // Nick message.
      return true;
    }

    // Separate the nick into the text and digits part.
    let nickParts = /^(.+?)(\d*)$/.exec(aOldNick);
    let newNick = nickParts[1];

    // No nick found from the user's preferences, so just generating one.
    // If there is not a digit at the end of the nick, just append 1.
    let newDigits = "1";
    // If there is a digit at the end of the nick, increment it.
    if (nickParts[2]) {
      newDigits = (parseInt(nickParts[2], 10) + 1).toString();
      // If there are leading 0s, add them back on, after we've incremented (e.g.
      // 009 --> 010).
      let numLeadingZeros = nickParts[2].length - newDigits.length;
      if (numLeadingZeros > 0)
        newDigits = "0".repeat(numLeadingZeros) + newDigits;
    }

    // If the nick will be too long, ensure all the digits fit.
    if (newNick.length + newDigits.length > this.maxNicknameLength) {
      // Handle the silly case of a single letter followed by all nines.
      if (newDigits.length == this.maxNicknameLength)
        newDigits = newDigits.slice(1);
      newNick = newNick.slice(0, this.maxNicknameLength - newDigits.length);
    }
    // Append the digits.
    newNick += newDigits;

    if (this.normalize(newNick) == this.normalize(this._nickname)) {
      // The nick we were about to try next is our current nick. This means
      // the user attempted to change to a version of the nick with a lower or
      // absent number suffix, and this failed.
      let msg = _("message.nick.fail", this._nickname);
      for each (let conversation in this._conversations)
        conversation.writeMessage(this._nickname, msg, {system: true});
      return true;
    }

    this.LOG(aOldNick + " is already in use, trying " + newNick);
    this.sendMessage("NICK", newNick); // Nick message.
    return true;
  },

  handlePingReply: function(aSource, aPongTime) {
    // Received PING response, display to the user.
    let sentTime = new Date(parseInt(aPongTime, 10));

    // The received timestamp is invalid.
    if (isNaN(sentTime)) {
      this.WARN(aMessage.servername +
                " returned an invalid timestamp from a PING: " + aPongTime);
      return false;
    }

    // Find the delay in milliseconds.
    let delay = Date.now() - sentTime;

    // If the delay is negative or greater than 1 minute, something is
    // feeding us a crazy value. Don't display this to the user.
    if (delay < 0 || 60 * 1000 < delay) {
      this.WARN(aMessage.servername +
                " returned an invalid delay from a PING: " + delay);
      return false;
    }

    let msg = PluralForm.get(delay, _("message.ping", aSource))
                        .replace("#2", delay);
    this.getConversation(aSource).writeMessage(aSource, msg, {system: true});
    return true;
  },

  countBytes: function(aStr) {
    // Assume that if it's not UTF-8 then each character is 1 byte.
    if (this._encoding != "UTF-8")
      return aStr.length;

    // Count the number of bytes in a UTF-8 encoded string.
    function charCodeToByteCount(c) {
      // UTF-8 stores:
      // - code points below U+0080 on 1 byte,
      // - code points below U+0800 on 2 bytes,
      // - code points U+D800 through U+DFFF are UTF-16 surrogate halves
      // (they indicate that JS has split a 4 bytes UTF-8 character
      // in two halves of 2 bytes each),
      // - other code points on 3 bytes.
      return c < 0x80 ? 1 : (c < 0x800 || (c >= 0xD800 && c <= 0xDFFF)) ? 2 : 3;
    }
    let bytes = 0;
    for (let i = 0; i < aStr.length; i++)
      bytes += charCodeToByteCount(aStr.charCodeAt(i));
    return bytes;
  },

  // To check if users are online, we need to queue multiple messages.
  // An internal queue of all nicks that we wish to know the status of.
  trackQueue: [],
  // The nicks that were last sent to the server that we're waiting for a
  // response about.
  pendingIsOnQueue: [],
  // The time between sending isOn messages (milliseconds).
  _isOnDelay: 60 * 1000,
  _isOnTimer: null,
  // The number of characters that are available to be filled with nicks for
  // each ISON message.
  _isOnLength: null,
  // Generate and send an ISON message to poll for each nick's status.
  sendIsOn: function() {
    // If no buddies, just look again after the timeout.
    if (this.trackQueue.length) {
      // Calculate the possible length of names we can send.
      if (!this._isOnLength) {
        let length = this.countBytes(this.buildMessage("ISON", " ")) + 2;
        this._isOnLength = this.maxMessageLength - length + 1;
      }

      // Always add the next nickname to the pending queue, this handles a silly
      // case where the next nick is greater than or equal to the maximum
      // message length.
      this.pendingIsOnQueue = [this.trackQueue.shift()];

      // Attempt to maximize the characters used in each message, this may mean
      // that a specific user gets sent very often since they have a short name!
      let buddiesLength = this.countBytes(this.pendingIsOnQueue[0]);
      for (let i = 0; i < this.trackQueue.length; ++i) {
        // If we can fit the nick, add it to the current buffer.
        if ((buddiesLength + this.countBytes(this.trackQueue[i])) < this._isOnLength) {
          // Remove the name from the list and add it to the pending queue.
          let nick = this.trackQueue.splice(i--, 1)[0];
          this.pendingIsOnQueue.push(nick);

          // Keep track of the length of the string, the + 1 is for the spaces.
          buddiesLength += this.countBytes(nick) + 1;

          // If we've filled up the message, stop looking for more nicks.
          if (buddiesLength >= this._isOnLength)
            break;
        }
      }

      // Send the message.
      this.sendMessage("ISON", this.pendingIsOnQueue.join(" "));

      // Append the pending nicks so trackQueue contains all the nicks.
      this.trackQueue = this.trackQueue.concat(this.pendingIsOnQueue);
    }

    // Call this function again in _isOnDelay seconds.
    // This makes the assumption that this._isOnDelay >> the response to ISON
    // from the server.
    this._isOnTimer = setTimeout(this.sendIsOn.bind(this), this._isOnDelay);
  },

  connect: function() {
    this.reportConnecting();

    // Load preferences.
    this._port = this.getInt("port");
    this._ssl = this.getBool("ssl");

    // Use the display name as the user's real name.
    this._realname = this.imAccount.statusInfo.displayName;
    this._encoding = this.getString("encoding") || "UTF-8";
    this._showServerTab = this.getBool("showServerTab");

    // Open the socket connection.
    this._socket = new radiognuSocket(this);
    this._socket.connect(this._server, this._port, this._ssl ? ["ssl"] : []);
  },

  // Functions for keeping track of whether the Client Capabilities is done.
  // If a cap is to be handled, it should be registered with addCAP, where aCAP
  // is a "unique" string defining what is being handled. When the cap is done
  // being handled removeCAP should be called with the same string.
  _caps: [],
  _capTimeout: null,
  addCAP: function(aCAP) {
    this._caps.push(aCAP);
  },
  removeCAP: function(aDoneCAP) {
    // Remove any reference to the given capability.
    this._caps = this._caps.filter(function(aCAP) aCAP != aDoneCAP);

    // If no more CAP messages are being handled, notify the server.
    if (!this._caps.length)
      this.sendMessage("CAP", "END");
  },

  // Used to wait for a response from the server.
  _quitTimer: null,
  // RFC 2812 Section 3.1.7.
  quit: function(aMessage) {
    this._reportDisconnecting(Ci.prplIAccount.NO_ERROR);
    this.sendMessage("QUIT",
                     aMessage || this.getString("quitmsg") || undefined);
  },
  // When the user clicks "Disconnect" in account manager, or uses /quit.
  // aMessage is an optional parameter containing the quit message.
  disconnect: function(aMessage) {
    if (this.disconnected || this.disconnecting)
      return;

    // If there's no socket, disconnect immediately to avoid waiting 2 seconds.
    if (!this._socket || this._socket.disconnected) {
      this.gotDisconnected();
      return;
    }

    // Let the server know we're going to disconnect.
    this.quit(aMessage);

    // Reset original nickname for the next reconnect.
    this._requestedNickname = this._accountNickname;

    // Give the server 2 seconds to respond, otherwise just forcefully
    // disconnect the socket. This will be cancelled if a response is heard from
    // the server.
    this._quitTimer = setTimeout(this.gotDisconnected.bind(this), 2 * 1000);
  },

  createConversation: function(aName) this.getConversation(aName),

  // Temporarily stores the prplIChatRoomFieldValues passed to joinChat for
  // each channel to enable later reconnections.
  _chatRoomFieldsList: {},

  // aComponents implements prplIChatRoomFieldValues.
  joinChat: function(aComponents) {
    let channel = aComponents.getValue("channel");
    if (!channel) {
      this.ERROR("joinChat called without a channel name.");
      return;
    }
    // A channel prefix is required. If the user didn't include one,
    // we prepend # automatically to match the behavior of other
    // clients. Not doing it used to cause user confusion.
    if (this.channelPrefixes.indexOf(channel[0]) == -1)
      channel = "#" + channel;

    // No need to join a channel we are already in.
    if (this.hasConversation(channel)) {
      let conv = this.getConversation(channel);
      if (!conv.left)
        return conv;
    }

    let params = [channel];
    let key = aComponents.getValue("password");
    if (key)
      params.push(key);
    let defaultName = key ? channel + " " + key : channel;
    this._chatRoomFieldsList[this.normalize(channel)] =
      this.getChatRoomDefaultFieldValues(defaultName);
    // Send the join command, but don't log the channel key.
    this.sendMessage("JOIN", params,
                     "JOIN " + channel + (key ? " <key not logged>" : ""));
    // Open conversation early for better responsiveness.
    return this.getConversation(channel);
  },

  chatRoomFields: {
    "channel": {get label() _("joinChat.channel"), required: true},
    "password": {get label() _("joinChat.password"), isPassword: true}
  },

  parseDefaultChatName: function(aDefaultName) {
    let params = aDefaultName.trim().split(/\s+/);
    let chatFields = {channel: params[0]};
    if (params.length > 1)
      chatFields.password = params[1];
    return chatFields;
  },

  // Attributes
  get canJoinChat() true,

  hasConversation: function(aConversationName)
    hasOwnProperty(this._conversations, this.normalize(aConversationName)),

  // Returns a conversation (creates it if it doesn't exist)
  getConversation: function(aName) {
    let name = this.normalize(aName);
    // If the whois information has been received, we have the proper nick
    // capitalization.
    if (hasOwnProperty(this.whoisInformation, name))
      aName = this.whoisInformation[name].nick;
    if (!this.hasConversation(aName)) {
      let constructor = this.isMUCName(aName) ? radiognuChannel : radiognuConversation;
      this._conversations[name] = new constructor(this, aName, this._nickname);
    }
    return this._conversations[name];
  },

  removeConversation: function(aConversationName) {
    if (this.hasConversation(aConversationName))
      delete this._conversations[this.normalize(aConversationName)];
  },

  // This builds the message string that will be sent to the server.
  buildMessage: function(aCommand, aParams) {
    if (!aCommand) {
      this.ERROR("IRC messages must have a command.");
      return null;
    }

    // Ensure a command is only characters or numbers.
    if (!/^[A-Z0-9]+$/i.test(aCommand)) {
      this.ERROR("IRC command invalid: " + aCommand);
      return null;
    }

    let message = aCommand;
    // If aParams is empty, then use an empty array. If aParams is not an array,
    // consider it to be a single parameter and put it into an array.
    let params = !aParams ? [] : Array.isArray(aParams) ? aParams : [aParams];
    if (params.length) {
      if (params.slice(0, -1).some(function(p) p.contains(" "))) {
        this.ERROR("IRC parameters cannot have spaces: " + params.slice(0, -1));
        return null;
      }
      // Join the parameters with spaces. There are three cases in which the
      // last parameter ("trailing" in RFC 2812) must be prepended with a colon:
      //  1. If the last parameter contains a space.
      //  2. If the first character of the last parameter is a colon.
      //  3. If the last parameter is an empty string.
      let trailing = params.slice(-1)[0];
      if (!trailing.length || trailing.contains(" ") || trailing.startsWith(":"))
        params.push(":" + params.pop());
      message += " " + params.join(" ");
    }

    return message;
  },

  // Shortcut method to build & send a message at once. Use aLoggedData to log
  // something different than what is actually sent.
  // Returns false if the message could not be sent.
  sendMessage: function(aCommand, aParams, aLoggedData)
    this.sendRawMessage(this.buildMessage(aCommand, aParams), aLoggedData),

  // This sends a message over the socket and catches any errors. Use
  // aLoggedData to log something different than what is actually sent.
  // Returns false if the message could not be sent.
  sendRawMessage: function(aMessage, aLoggedData) {
    // Low level quoting, replace \0, \n, \r or \020 with \0200, \020n, \020r or
    // \020\020, respectively.
    const lowQuote = {"\0": "0", "\n": "n", "\r": "r", "\x10": "\x10"};
    const lowRegex = new RegExp("[" + Object.keys(lowQuote).join("") + "]", "g");
    aMessage = aMessage.replace(lowRegex, function(aChar) "\x10" + lowQuote[aChar]);

    if (!this._socket || this._socket.disconnected) {
      this.gotDisconnected(Ci.prplIAccount.ERROR_NETWORK_ERROR,
                           _("connection.error.lost"));
    }

    let length = this.countBytes(aMessage) + 2;
    if (length > this.maxMessageLength) {
      // Log if the message is too long, but try to send it anyway.
      this.WARN("Message length too long (" + length + " > " +
                this.maxMessageLength + "\n" + aMessage);
    }

    aMessage += "\r\n";

    try {
      this._socket.sendString(aMessage, this._encoding, aLoggedData);
      return true;
    } catch (e) {
      try {
        this._socket.sendData(aMessage, aLoggedData);
        this.WARN("Failed to convert " + aMessage + " from Unicode to " +
                  this._encoding + ".");
        return true;
      } catch(e) {
        this.ERROR("Socket error:", e);
        this.gotDisconnected(Ci.prplIAccount.ERROR_NETWORK_ERROR,
                             _("connection.error.lost"));
        return false;
      }
    }
  },

  // CTCP messages are \001<COMMAND> [<parameters>]*\001.
  // Returns false if the message could not be sent.
  sendCTCPMessage: function(aCommand, aParams, aTarget, aIsNotice) {
    // Combine the CTCP command and parameters into the single IRC param.
    let ircParam = aCommand;
    // If aParams is empty, then use an empty array. If aParams is not an array,
    // consider it to be a single parameter and put it into an array.
    let params = !aParams ? [] : Array.isArray(aParams) ? aParams : [aParams];
    if (params.length)
      ircParam += " " + params.join(" ");

    // High/CTCP level quoting, replace \134 or \001 with \134\134 or \134a,
    // respectively. This is only done inside the extended data message.
    const highRegex = /\\|\x01/g;
    ircParam = ircParam.replace(highRegex,
      function(aChar) "\\" + (aChar == "\\" ? "\\" : "a"));

    // Add the CTCP tagging.
    ircParam = "\x01" + ircParam + "\x01";

    // Send the IRC message as a NOTICE or PRIVMSG.
    return this.sendMessage(aIsNotice ? "NOTICE" : "PRIVMSG", [aTarget, ircParam]);
  },

  // Implement section 3.1 of RFC 2812
  _connectionRegistration: function() {
    // Send the Client Capabilities list command.
    this.sendMessage("CAP", "LS");

    if (this.prefs.prefHasUserValue("serverPassword")) {
      this.sendMessage("PASS", this.getString("serverPassword"),
                       "PASS <password not logged>");
    }

    // Send the nick message (section 3.1.2).
    this.sendMessage("NICK", this._requestedNickname);

    // Send the user message (section 3.1.3).
    let username;
    // Use a custom username in a hidden preference.
    if (this.prefs.prefHasUserValue("username"))
      username = this.getString("username");
    // But fallback to brandShortName if no username is provided (or is empty).
    if (!username)
      username = Services.appinfo.name;
    this.sendMessage("USER", [username, this._mode.toString(), "*",
                              this._realname || this._requestedNickname]);
  },

  _reportDisconnecting: function(aErrorReason, aErrorMessage) {
    this.reportDisconnecting(aErrorReason, aErrorMessage);

    // Mark all contacts on the account as having an unknown status.
    for each (let buddy in this._buddies)
      buddy.setStatus(Ci.imIStatusInfo.STATUS_UNKNOWN, "");
  },

  gotDisconnected: function(aError, aErrorMessage) {
    if (!this.imAccount || this.disconnected)
       return;

    if (aError === undefined)
      aError = Ci.prplIAccount.NO_ERROR;
    // If we are already disconnecting, this call to gotDisconnected
    // is when the server acknowledges our disconnection.
    // Otherwise it's because we lost the connection.
    if (!this.disconnecting)
      this._reportDisconnecting(aError, aErrorMessage);
    this._socket.disconnect();
    delete this._socket;

    clearTimeout(this._isOnTimer);
    delete this._isOnTimer;

    // We must authenticate if we reconnect.
    delete this.isAuthenticated;

    // Clean up each conversation: mark as left and remove participant.
    for each (let conversation in this._conversations) {
      if (conversation.isChat && !conversation.left) {
        // Remove the user's nick and mark the conversation as left as that's
        // the final known state of the room.
        conversation.removeParticipant(this._nickname, true);
        conversation.left = true;
      }
    }

    // If we disconnected during a pending LIST request, make sure callbacks
    // receive any remaining channels.
    if (this._pendingList)
      this._sendRemainingRoomInfo();

    // Clear whois table.
    this.whoisInformation = {};

    this.reportDisconnected();
  },

  remove: function() {
    for each (let conv in this._conversations)
      conv.close();
    delete this._conversations;
    for each (let buddy in this._buddies)
      buddy.remove();
    delete this._buddies;
  },

  unInit: function() {
    // Disconnect if we're online while this gets called.
    if (this._socket) {
      if (!this.disconnecting)
        this.quit();
      this._socket.disconnect();
    }
    delete this.imAccount;
    clearTimeout(this._isOnTimer);
    clearTimeout(this._quitTimer);
  }
};

function radiognuProtocol() {
  // ircCommands.jsm exports one variable: commands. Import this directly into
  // the protocol object.
  Cu.import("resource:///modules/ircCommands.jsm", this);
  this.registerCommands();

  // Register the standard handlers.
  let tempScope = {};
  Cu.import("resource:///modules/ircBase.jsm", tempScope);
  Cu.import("resource:///modules/ircISUPPORT.jsm", tempScope);
  Cu.import("resource:///modules/ircCAP.jsm", tempScope);
  Cu.import("resource:///modules/ircCTCP.jsm", tempScope);
  Cu.import("resource:///modules/ircDCC.jsm", tempScope);
  Cu.import("resource:///modules/ircServices.jsm", tempScope);

  // Extra features.
  Cu.import("resource:///modules/ircMultiPrefix.jsm", tempScope);
  Cu.import("resource:///modules/ircNonStandard.jsm", tempScope);
  Cu.import("resource:///modules/ircSASL.jsm", tempScope);
  Cu.import("resource:///modules/ircWatchMonitor.jsm", tempScope);

  // Register default IRC handlers (IRC base, CTCP).
  ircHandlers.registerHandler(tempScope.ircBase);
  ircHandlers.registerHandler(tempScope.ircISUPPORT);
  ircHandlers.registerHandler(tempScope.ircCAP);
  ircHandlers.registerHandler(tempScope.ircCTCP);
  ircHandlers.registerHandler(tempScope.ircServices);
  // Register default ISUPPORT handler (ISUPPORT base).
  ircHandlers.registerISUPPORTHandler(tempScope.isupportBase);
  // Register default CTCP handlers (CTCP base, DCC).
  ircHandlers.registerCTCPHandler(tempScope.ctcpBase);
  ircHandlers.registerCTCPHandler(tempScope.ctcpDCC);
  // Register default IRC Services handlers (IRC Services base).
  ircHandlers.registerServicesHandler(tempScope.servicesBase);

  // Register extra features.
  ircHandlers.registerISUPPORTHandler(tempScope.isupportNAMESX);
  ircHandlers.registerCAPHandler(tempScope.capMultiPrefix);
  ircHandlers.registerHandler(tempScope.ircNonStandard);
  ircHandlers.registerHandler(tempScope.ircWATCH);
  ircHandlers.registerISUPPORTHandler(tempScope.isupportWATCH);
  ircHandlers.registerHandler(tempScope.ircMONITOR);
  ircHandlers.registerISUPPORTHandler(tempScope.isupportMONITOR);
  ircHandlers.registerHandler(tempScope.ircSASL);
  ircHandlers.registerCAPHandler(tempScope.capSASL);
}
radiognuProtocol.prototype = {
  __proto__: GenericProtocolPrototype,
  get name() "RadioGNU",
  get iconBaseURI() "chrome://prpl-radiognu/skin/",
  get usernameEmptyText() _("irc.usernameHint"),
  get baseId() "prpl-radiognu",

  usernameSplits: [
    {get label() _("options.server"), separator: "@",
     defaultValue: "irc.radiognu.org", reverse: true}
  ],

  options: {
    "port": {get label() _("options.port"),  default: "6667",
                                   listValues: {"6667": "Normal",
                                                "7767": "Secure"}},
    "ssl": {get label() _("options.ssl"), default: false},
    // TODO We should attempt to auto-detect encoding instead.
    "encoding": {get label() _("options.encoding"), default: "UTF-8"},
    "quitmsg": {get label() _("options.quitMessage"), default: "Radio\u00D1\u00FA: La emisora del \u00F1u que te da nota."},
    "partmsg": {get label() _("options.partMessage"), default: ""},
    "showServerTab": {get label() _("options.showServerTab"), default: false},
    "alternateNicks": {get label() _("options.alternateNicks"), default: ""}
  },

  get chatHasTopic() true,
  get slashCommandsNative() true,
  //  Passwords in IRC are optional, and are needed for certain functionality.
  get passwordOptional() true,

  getAccount: function(aImAccount) new radiognuAccount(this, aImAccount),
  classID: Components.ID("{a58207a0-df1f-11e4-8830-0800200c9a66}")
};

const NSGetFactory = XPCOMUtils.generateNSGetFactory([radiognuProtocol]);
