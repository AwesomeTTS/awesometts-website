# -*- coding: utf-8 -*-

# AwesomeTTS text-to-speech add-on website
# Copyright (C) 2014-Present  Anki AwesomeTTS Development Team
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.

"""
WSGI callables for service relays

Handlers here provide a way for users of the add-on to access certain
services that cannot be communicated with directly (e.g. text-to-speech
APIs that require authenticated access).
"""

from collections import namedtuple as _namedtuple
from json import dumps as _json
from logging import error as _error, info as _info, warning as _warn
from threading import Lock as _Lock
from time import time as _time
from urllib2 import urlopen as _url_open, Request as _Request

__all__ = ['voicetext']


# n.b. When adding additional mustached-in variables, add a build-time check
# for `KEYS_RELAYS_MISSING` in ../Gruntfile.js so nothing gets missed during a
# deployment.

# For auth, VoiceText uses API key as the "username" w/ blank password, e.g.:
# import base64; 'Basic ' + base64.encodestring('someapikey123' + ':').strip()
_API_VOICETEXT_AUTH = dict(Authorization='{{{voicetext}}}')
_API_VOICETEXT_ENDPOINT = 'https://api.voicetext.jp/v1/tts'
_API_VOICETEXT_TIMEOUT = 10

_AWESOMETTS = 'AwesomeTTS/'

_CODE_200 = '200 OK'
_CODE_400 = '400 Bad Request'
_CODE_403 = '403 Forbidden'
_CODE_405 = '405 Method Not Allowed'
_CODE_429 = '429 Too Many Requests'
_CODE_502 = '502 Bad Gateway'
_CODE_503 = '503 Service Unavailable'

_HEADERS_JSON = [('Content-Type', 'application/json')]


def _get_message(msg):
    "Returns a list-of-one-string payload for returning from handlers."
    return [_json(dict(message=msg), separators=(',', ':'))]

_MSG_CAPACITY = _get_message("This service is over capacity")
_MSG_DENIED = _get_message("You may not call this endpoint directly")
_MSG_TOO_MANY = _get_message("You have made too many calls to the service")
_MSG_UNACCEPTABLE = _get_message("Your request is unacceptable")
_MSG_UPSTREAM = _get_message("Cannot communicate with upstream service")


# Rate limiting for this running instance. Each tuple contains the following:
#
# 0. within these number of seconds (or until instance dies, if sooner) ...
# 1. ... a single IP address may make at most this many calls
# 2. ... at most this many IP addresses may be using relays
# 3. accounting dict mapping IP addresses to their access information
#
# TODO: If we add additional relay services in the future, those relays should
# use this same structure (i.e. rate-limiting should be in-effect across all
# of the relays that we sponsor).
#
# TODO: If we ever expand to having more than one running instance on Google
# App Engine, this data structure would not be shared between them, and this
# rate-limiting strategy would need to be reconsidered.

# pylint:disable=invalid-name
_LimitLevel = _namedtuple('LimitLevel',
                          ['within', 'max_single', 'max_total', 'lookup'])
_limit_levels = [_LimitLevel(60, 25, 5, {}), _LimitLevel(86400, 500, 100, {})]
_limit_lock = _Lock()
# pylint:enable=invalid-name


def voicetext(environ, start_response):
    """
    After validating the incoming request, retrieve the audio file from
    the upstream VoiceText service, check it, and return it.
    """

    remote_addr = environ.get('REMOTE_ADDR', '')
    if not remote_addr:
        _warn("Relay denied -- no remote IP address")
        start_response(_CODE_403, _HEADERS_JSON)
        return _MSG_DENIED

    if not environ.get('HTTP_USER_AGENT', '').startswith(_AWESOMETTS):
        _warn("Relay denied -- unauthorized user agent")
        start_response(_CODE_403, _HEADERS_JSON)
        return _MSG_DENIED

    if environ.get('REQUEST_METHOD') != 'GET':
        _warn("Relay denied -- unacceptable request method")
        start_response(_CODE_405, _HEADERS_JSON)
        return _MSG_UNACCEPTABLE

    data = environ.get('QUERY_STRING')

    # do a very rough sanity check without generating a bunch of junk objects;
    # remember that most Japanese characters encode to 9-byte strings and we
    # allow up to 100 Japanese characters (or 900 bytes) in the client
    if not (data and len(data) < 1000 and data.count('&') > 4 and
            data.count('=') < 8 and 'format=' in data and
            'format=wav' not in data and
            'pitch=' in data and 'speaker=' in data and 'speed=' in data and
            'text=' in data and 'volume=' in data):
        _warn("Relay denied -- unacceptable query string")
        start_response(_CODE_400, _HEADERS_JSON)
        return _MSG_UNACCEPTABLE

    # apply rate-limiting
    with _limit_lock:
        now = int(_time())

        # remove expired entries
        for level in _limit_levels:
            expired = now - level.within
            lookup = level.lookup
            for addr, info in lookup.items():
                if info['created'] < expired:
                    del lookup[addr]

        # check maximum levels
        for level in _limit_levels:
            lookup = level.lookup
            try:
                info = lookup[remote_addr]
            except KeyError:
                total = len(lookup)
                if total >= level.max_total:
                    _warn("Relay denied -- already have %d total callers "
                          "within the last %d seconds", total, level.within)
                    start_response(_CODE_503, _HEADERS_JSON)
                    return _MSG_CAPACITY
            else:
                calls = info['calls']
                if calls >= level.max_single:
                    _warn("Relay denied -- already had %d individual calls "
                          "from %s within the last %d seconds",
                          calls, remote_addr, level.within)
                    start_response(_CODE_429, _HEADERS_JSON)
                    return _MSG_TOO_MANY

        # caller is good to go; update their call counts
        summaries = []
        for level in _limit_levels:
            lookup = level.lookup
            try:
                info = lookup[remote_addr]
            except KeyError:
                lookup[remote_addr] = info = {'created': now, 'calls': 1}
            else:
                info['calls'] += 1
            summaries.append("%d-second window has %d/%d individual calls for "
                             "%s and %d/%d total unique callers" %
                             (level.within, info['calls'], level.max_single,
                              remote_addr, len(lookup), level.max_total))
        _info("Relay accepted -- %s", "; ".join(summaries))

    try:
        response = _url_open(_Request(_API_VOICETEXT_ENDPOINT, data,
                                      _API_VOICETEXT_AUTH),
                             timeout=_API_VOICETEXT_TIMEOUT)

        if response.getcode() != 200:
            raise IOError("non-200 status code from upstream service")

        mime = response.info().gettype()
        if not mime.startswith('audio/'):
            raise IOError("non-audio format from upstream service")

        payload = [response.read()]

    except Exception as exception:  # catch all, pylint:disable=broad-except
        _error("Relay failed -- %s", exception)
        start_response(_CODE_502, _HEADERS_JSON)
        return _MSG_UPSTREAM

    else:
        start_response(_CODE_200, [('Content-Type', mime)])
        return payload

    finally:
        try:
            response.close()
        except Exception:  # catch all, pylint:disable=broad-except
            pass
