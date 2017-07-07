# -*- coding: utf-8 -*-
# pylint:disable=bad-continuation

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
WSGI callables for unresolved requests

Handlers here attempt to redirect requests to a new path by normalizing
them. If the normalized path differs from what was originally requested,
a permanent redirect is sent with a warning logged to the environment.
Otherwise, specific logic is followed depending on the handler to decide
what error to send the user and how to log to the environment.
"""

# pylint:disable=bad-continuation

__all__ = ['api', 'other']

import json
from logging import debug, warn, error
from re import compile as re

debug("Loading responders in %s package" % __package__)


def api(environ, start_response):
    """
    If a redirect cannot be performed, attempts to guess what went wrong
    before logging an error to the environment, setting a 404 status
    code, and returning a JSON error document.
    """

    path, new_path = get_paths(environ)

    if new_path:
        start_response(
            '301 Moved Permanently',
            api.headers + [('Location', new_path)],
        )
        warn("API redirect to " + new_path)
        return api.json("Try %s instead" % new_path)

    else:
        start_response('404 Not Found', api.headers)
        error("Nothing suitable; returning 404 error JSON")
        return api.response404

api.headers = [('Content-Type', 'application/json')]

api.json = lambda message: [json.dumps(
    dict(message=message),
    separators=(',', ':'),
    sort_keys=True,
)]

api.response404 = api.json("No such endpoint")



def other(environ, start_response):
    """
    If a redirect cannot be performed, logs an error to the environment,
    sets a 404 status code with appropriate headers, and returns a
    static error document.
    """

    old_path, new_path = get_paths(environ)
    if not new_path:
        if old_path in other.redirects:
            new_path = other.redirects[old_path]
        elif old_path.startswith('/services/'):
            new_path = '/services'

    if new_path:
        start_response(
            '301 Moved Permanently',
            other.headers + [('Location', new_path)],
        )
        warn("Website redirect to " + new_path)
        return [other.template301 % {'path': new_path}]

    else:
        start_response('404 Not Found', other.headers)
        error("Nothing suitable; returning 404 error page")
        return other.response404

other.headers = [('Content-Type', 'text/html; charset=utf-8')]

with open('redirects.json', 'r') as _source:
    other.redirects = {
        str(_old): str(_new)
        for _old, _new in json.load(_source).items()
    }

with open(__package__ + '/error404.html', 'r') as _source:
    other.response404 = [_source.read()]

with open(__package__ + '/redirect.html', 'r') as _source:
    other.template301 = _source.read()


def get_paths(environ):
    """
    Attempts to normalize the path from the environment (e.g. removing
    excessive symbols, filtering junk characters, lowercasing). If this
    process successfully produces a path different from the one that was
    requested in the first place, returns the old path and new path as a
    tuple. If not, returns a tuple with the old path and None.
    """

    old_path = environ.get('PATH_INFO')

    if old_path:
        new_path = '/' + '/'.join(
            component
            for component in [
                component.strip('-.')
                for component in
                    get_paths.re_excessive_any.sub('.',
                    get_paths.re_excessive_dashes.sub('-',
                    get_paths.re_excessive_periods.sub('.',
                    get_paths.re_filter_characters.sub('',
                    get_paths.re_filter_encoding.sub('',
                        old_path
                    ))))).lower().split('/')
            ]
            if component
        )

        if new_path != old_path:
            return old_path, new_path

    return old_path, None

get_paths.re_excessive_any = re(r'[-.]{2,}')
get_paths.re_excessive_dashes = re(r'-{2,}')
get_paths.re_excessive_periods = re(r'\.{2,}')
get_paths.re_filter_characters = re(r'[^-./A-Za-z0-9]')
get_paths.re_filter_encoding = re(r'%[0-9A-Fa-f]{2}')
