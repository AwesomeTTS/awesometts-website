/*
 * AwesomeTTS text-to-speech add-on website
 * Copyright (C) 2014-Present  Anki AwesomeTTS Development Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * Gruntfile for AwesomeTTS website and update API service
 *
 * Provides Grunt tasks for building the project, running it locally, and
 * deploying it to Google App Engine with a git-derived version.
 *
 * Examples:
 *     $ grunt build      # builds project to the build/ subdirectory
 *
 *     $ grunt deploy     # builds project and sends new version to GAE
 *
 *     $ grunt run        # builds project and then runs the GAE SDK server
 *                        # with its logging output sent to the console
 *
 *     $ grunt watch      # monitors file system to automatically rebuild the
 *                        # project as needed (but does NOT do initial build)
 *
 *     $ grunt run watch  # combines the above two, but the GAE SDK server is
 *                        # backgrounded, so only watch activity is visible
 *
 *     $ grunt clean      # removes the contents of build/ subdirectory
 */

/*jslint indent:4*/
/*jslint node:true*/
/*jslint regexp:true*/

module.exports = function (grunt) {
    'use strict';

    var doWatch = grunt.cli.tasks.indexOf('watch') !== -1;

    // By default, the `gae:update` task uses `gcloud app deploy` directly
    // rather than using `appcfg.py update` via the `grunt-gae` module. If you
    // do have the older Google App Engine SDK w/ `appcfg.py` installed and
    // you want to use that instead, you can pass the `--no-gcloud` flag when
    // running `grunt deploy`.
    var USE_GCLOUD_DEPLOYMENT = !grunt.option('no-gcloud');

    var SITEMAP = (function getSubtree(nodes, urlBase, parent) {
        var prev;

        return Object.keys(nodes).map(function (slug) {
            var node = nodes[slug];
            var href = [urlBase, slug].join('/');
            var isObject = typeof node === 'object';
            var result = {
                me: {
                    href: href,
                    slug: slug,
                    terse: String(isObject ? node.terse || node.title : node),
                    title: String(isObject ? node.title : node),
                    what: isObject && node.what && String(node.what) || "",
                },
                isDynamic: false,
                isHome: false,
                isInterior: true,
            };

            if (parent) {
                result.parent = parent.me;
            }

            if (isObject && typeof node.children === 'object' &&
              Object.keys(node.children).length > 0) {
                result.isParent = true;
                result.children = getSubtree(node.children, href, result);
            } else {
                result.isParent = false;
            }

            if (prev) {
                result.prev = prev.me;
                prev.next = result.me;
            }

            prev = result;
            return result;
        });
    }(grunt.file.readJSON('sitemap.json'), ''));

    var KEYS = {};
    var KEYS_MISSING = [];
    var KEYS_RELAYS_MISSING = [];
    try { KEYS = grunt.file.readJSON('keys.json'); } catch (ignore) { }
    [['relays', {}]].forEach(function (tuple) {
        if (!KEYS[tuple[0]]) {
            KEYS[tuple[0]] = tuple[1];
            KEYS_MISSING.push(tuple[0]);
        }
    });
    ['voicetext'].forEach(function (relay) {
        if (!KEYS.relays[relay]) {
          KEYS.relays[relay] = '???';
          KEYS_RELAYS_MISSING.push(relay);
        }
    });

    var gaeRegex = function (strings, forceWrap) {
        var map = {};

        strings.forEach(function (string) {
            var current = map;

            string.split('').forEach(function (character) {
                if (!current[character]) {
                    current[character] = {};
                }
                current = current[character];
            });

            current.end = true;
        });

        var safe = /[\-\w\/]/;
        var esc = function (character) {
            return safe.test(character) ? character : ('\\' + character);
        };

        return (function subpattern(lookup, forceWrap) {
            var end = lookup.end;
            var characters = Object.keys(lookup).
                             filter(function (key) { return key !== 'end'; }).
                             sort();

            switch (characters.length) {
                case 0:
                    return '';

                case 1:
                    var character = characters[0];
                    var next = subpattern(lookup[character]);

                    return end ? '(' + esc(character) + next + ')?' :
                        forceWrap ? '(' + esc(character) + next + ')' :
                        esc(character) + next;

                default:
                    var inside = characters.
                        map(function (character) {
                            return esc(character) +
                                subpattern(lookup[character]);
                        }).
                        join('|');

                    return end ? '(' + inside + ')?' : '(' + inside + ')';
            }
        }(map, forceWrap));
    };

    var config = {pkg: 'package.json'};
    grunt.config.init(config);


    // Task Aliases //////////////////////////////////////////////////////////

    grunt.task.registerTask('default', 'help');
    grunt.task.registerTask('help', "Display usage.", grunt.help.display);

    grunt.task.registerTask('build', "Build all into build subdirectory.", [
        'clean', 'copy', 'json-minify', 'sass', 'cssmin', 'mustache_render',
        'replace', 'htmlmin', 'appyaml',
    ]);

    grunt.task.registerTask('run', "Runs project locally using GAE SDK.", [
        'build', 'gae:run',
    ]);

    grunt.task.registerTask('deploy', "Pushes new version to GAE platform.", [
        'keycheck', 'build', 'version', 'gae:update',
    ]);


    // Clean-Up (clean) //////////////////////////////////////////////////////

    grunt.task.loadNpmTasks('grunt-contrib-clean');
    config.clean = {build: 'build/*'};


    // File Copy (copy) //////////////////////////////////////////////////////

    grunt.task.loadNpmTasks('grunt-contrib-copy');
    config.copy = {
        favicon: {src: 'favicon.ico', dest: 'build/'},
        touchIcon: {src: 'apple-touch-icon.png', dest: 'build/'},
        images: {src: 'images/*.{gif,png}', dest: 'build/'},
        redirects: {src: 'redirects.json', dest: 'build/'},
        dntPolicy: {src: 'dnt-policy.txt', dest: 'build/'},
        robots: {src: 'robots.txt', dest: 'build/'},
        unresolvedPy: {src: 'unresolved/__init__.py', dest: 'build/'},
        api: {src: 'api/**/*.json', dest: 'build/'},  // minify in-place next
    };


    // JSON Minification In-Place (json-minify) //////////////////////////////
    // n.b. unlike other minfication plug-ins, this one only works in-place //

    grunt.task.loadNpmTasks('grunt-json-minify');
    config['json-minify'] = {api: {files: 'build/api/**/*.json'}};


    // Stylesheet Compilation (sass) /////////////////////////////////////////

    grunt.task.loadNpmTasks('grunt-sass');
    config.sass = {
        style: {files: {'build/style.css': 'style.scss'}},
    };


    // Stylesheet Minification In-Place (cssmin) /////////////////////////////

    grunt.task.loadNpmTasks('grunt-contrib-cssmin');
    config.cssmin = {
        options: {keepSpecialComments: 0},
        style: {files: {'build/style.css': 'build/style.css'}},
    };


    // HTML Generation from Mustache Templates (mustache_render) /////////////

    grunt.task.loadNpmTasks('grunt-mustache-render');
    (function () {
        var homeHelper = function (page, masthead) {
            return [
                '<a href="/" rel="',
                     page.isHome && 'home index me' ||
                    (page.parent || page.isDynamic) && 'home index' ||
                    'home index parent',
                '">',
                    masthead ? 'AwesomeTTS for Anki' : 'Home',
                '</a>'
            ].join('');
        };

        var linkHelper = function (ctx, page, verbose) {
            var rels = '';
            var me = ctx.me || ctx;

            if (page.isHome) {
                if (!ctx.parent) {
                    rels = ' rel="child"';
                }
            } else if (page.me) {
                rels = me.href === page.me.href && 'me' ||
                    page.parent && me.href === page.parent.href && 'parent' ||
                    page.prev && me.href === page.prev.href && 'prev' ||
                    page.next && me.href === page.next.href && 'next' ||
                    ctx.parent && ctx.parent.href === page.me.href && 'child';

                rels = rels ? [' rel="', '"'].join(rels) : '';
            }

            return [
                '<a href="', me.href, '"', rels, '>',
                verbose ? me.title : me.terse,
                '</a> ',
                verbose ? '<br>' + me.what : "",
            ].join('');
        };

        var data = function (node) {
            var result = {
                helpers: {
                    child: function () {
                        return linkHelper(this, node, true);
                    },
                    home: function () {
                        return homeHelper(node);
                    },
                    link: function () {
                        return linkHelper(this, node);
                    },
                    masthead: function () {
                        return homeHelper(this, node, true);
                    },
                },

                sitemap: SITEMAP,
            };

            Object.keys(node).forEach(function (key) {
                result[key] = node[key];
            });

            return result;
        };

        var getMustacheRenderPages = function(nodes) {
            return Array.prototype.concat.apply(
                [],
                nodes.map(function (node) {
                    var fragment = 'pages' + node.me.href;

                    if (node.children) {
                        return Array.prototype.concat(
                            {
                                data: data(node),
                                template: fragment + '/index.mustache',
                                dest: 'build/' + fragment + '/index.html',
                            },
                            getMustacheRenderPages(node.children)
                        );
                    }

                    return {
                        data: data(node),
                        template: fragment + '.mustache',
                        dest: 'build/' + fragment + '.html',
                    };
                })
            );
        };

        config.mustache_render = {
            options: {clear_cache: doWatch, directory: 'partials/'},

            pages: {files: Array.prototype.concat(
                {
                    data: data({
                        children: SITEMAP,
                        isDynamic: false,
                        isHome: true,
                        isInterior: false,
                        isParent: SITEMAP.length > 0,
                    }),
                    template: 'pages/index.mustache',
                    dest: 'build/pages/index.html',
                },
                getMustacheRenderPages(SITEMAP)
            )},

            relaysPy: {files: [{
                data: KEYS.relays,
                template: 'relays/__init__.py',
                dest: 'build/relays/__init__.py',
            }]},

            unresolvedError404: {files: [{
                data: data({
                    me: {title: "Not Found"},
                    isDynamic: true,
                    isHome: false,
                    isInterior: false,
                    isParent: false,
                }),
                template: 'unresolved/error404.mustache',
                dest: 'build/unresolved/error404.html',
            }]},

            unresolvedRedirect: {files: [{
                data: data({
                    me: {title: "Moved Permanently"},
                    isDynamic: true,
                    isHome: false,
                    isInterior: false,
                    isParent: false,
                }),
                template: 'unresolved/redirect.mustache',
                dest: 'build/unresolved/redirect.html',
            }]},
        };
    }());


    // HTML Path Simplification In-Place (replace) ///////////////////////////

    grunt.task.loadNpmTasks('grunt-replace');
    config.replace = {
        toplevels: {
            files: [{expand: true, cwd: 'build/',
              src: ['pages/*.html', 'pages/*/index.html'], dest: 'build/'}],
            options: {patterns: [{
                match: /(href|src)="\/(\w[^"]*)"/g,
                replacement: function (match, attr, url) {
                    return [attr, '="', url, '"'].join('');
                },
            }]},
        },

        secondaries: {
            files: [{expand: true, cwd: 'build/',
              src: ['pages/*/*.html', '!pages/*/index.html'], dest: 'build/'}],
            options: {patterns: [{
                match: /(href|src)="\/(\w[^"]*)"/g,
                replacement: function (match, attr, url, offset, html, path) {
                    url = url.split('/');
                    path = path.split('/');

                    return url[0] === path[2] && url[1] ?
                        [attr, '="', url.slice(1).join('/'), '"'].join('') :
                        match;
                },
            }]},
        },
    };


    // HTML Minification In-Place (htmlmin) //////////////////////////////////
    // n.b. we run this one in-place in order to operate on mustache output //

    grunt.task.loadNpmTasks('grunt-contrib-htmlmin');
    config.htmlmin = {
        options: {collapseBooleanAttributes: true, collapseWhitespace: true,
          html5: true, minifyCSS: true, removeAttributeQuotes: true,
          removeComments: true, removeEmptyAttributes: true,
          removeEmptyElements: true, removeOptionalTags: true,
          removeRedundantAttributes: true, removeStyleLinkTypeAttributes: true,
          sortAttributes: true, sortClassName: true},

        pages: {expand: true, cwd: 'build/', src: 'pages/**/*.html',
          dest: 'build/'},
        unresolvedError404: {expand: true, cwd: 'build/',
          src: 'unresolved/error404.html', dest: 'build/'},
        unresolvedRedirect: {expand: true, cwd: 'build/',
          src: 'unresolved/redirect.html', dest: 'build/'},
    };


    // app.yaml Builder Task (appyaml) ///////////////////////////////////////

    grunt.task.registerTask('appyaml', "Build app.yaml config.", function () {
        var MIME_HTML = 'text/html; charset=utf-8';

        var HEADERS_HTML = {
            'X-UA-Compatible': 'IE=edge',
        };

        var BASICS = {
            runtime: 'python27',
            api_version: '1',
            threadsafe: true,
            automatic_scaling: {max_idle_instances: 1},
            default_expiration: '1d',
        };
        if (!USE_GCLOUD_DEPLOYMENT) {
            BASICS.application = 'ankiatts';
            BASICS.version = 'local';
        }

        var INDICES = '/' + gaeRegex(
            SITEMAP.
                filter(function (node) { return node.children; }).
                map(function (node) { return node.me.slug; }),
            true
        );

        var LEAVES = '/' + gaeRegex(
            Array.prototype.concat.apply(
                SITEMAP.
                    filter(function (node) { return !node.children; }).
                    map(function (node) { return node.me.slug; }),

                SITEMAP.
                    filter(function (node) { return node.children; }).
                    map(function (node) {
                        return node.children.map(function (subnode) {
                            return node.me.slug + '/' + subnode.me.slug;
                        });
                    })
            ),
            true
        );

        var GIF_IMAGES = '/' + gaeRegex(
            grunt.file.expand('images/*.gif').map(function (path) {
                return path.replace(/^images\/|\.gif$/g, '');
            }),
            true
        );

        var PNG_IMAGES = '/' + gaeRegex(
            grunt.file.expand('images/*.png').map(function (path) {
                return path.replace(/^images\/|\.png$/g, '');
            }),
            true
        );

        var HANDLERS = [
            {url: '/', static_files: 'pages/index.html',
              upload: 'pages/index\\.html', mime_type: MIME_HTML,
              http_headers: HEADERS_HTML},
            {url: INDICES, static_files: 'pages/\\1/index.html',
              upload: ['pages', INDICES, '/index\\.html'].join(''),
              mime_type: MIME_HTML, http_headers: HEADERS_HTML},
            {url: LEAVES, static_files: 'pages/\\1.html',
              upload: ['pages', LEAVES, '\\.html'].join(''),
              mime_type: MIME_HTML, http_headers: HEADERS_HTML},
            {url: GIF_IMAGES + '\\.gif', static_files: 'images/\\1.gif',
              upload: 'images/.+\\.gif', expiration: '35d'},
            {url: PNG_IMAGES + '\\.png', static_files: 'images/\\1.png',
              upload: 'images/.+\\.png', expiration: '35d'},

            {url: '/style\\.css', static_files: 'style.css',
              upload: 'style\\.css', expiration: '35d'},
            {url: '/favicon\\.ico', static_files: 'favicon.ico',
              upload: 'favicon\\.ico', expiration: '70d'},
            {url: '/apple-touch-icon\\.png',
             static_files: 'apple-touch-icon.png',
              upload: 'apple-touch-icon\\.png', expiration: '70d'},
            {url: '/\\.?well-known/dnt-policy\\.txt',
              static_files: 'dnt-policy.txt',
              upload: 'dnt-policy\\.txt', expiration: '70d',
              mime_type: 'text/plain; charset=utf-8'},
            {url: '/robots\\.txt', static_files: 'robots.txt',
              upload: 'robots\\.txt', expiration: '70d'},

            // @tbd We might need to distinguish between the 2.0 and 2.1
            // releases of Anki in the future.
            {url: '/api/update/2\\.\\d+\\.\\d+-[a-z\\d]+-' + gaeRegex([
                '1.11.0',
              ]),
              static_files: 'api/update/good-version.json',
              upload: 'api/update/good-version\\.json'},
            {url: '/api/update/2\\.\\d+\\.\\d+-[a-z\\d]+-' + gaeRegex([
                '1.11.0-dev', '1.10.0',
                '1.10.0-pre', '1.10.0-dev', '1.9.0', '1.9.0-pre', '1.9.0-dev',
              ]),
              static_files: 'api/update/need-newer.json',
              upload: 'api/update/need-newer\\.json'},
            {url: '/api/update/[a-z\\d]+-' + gaeRegex([
                '1.9.0-dev', '1.8.0', '1.8.0-pre', '1.8.0-dev', '1.7.0',
                '1.7.0-pre', '1.7.0-dev', '1.6.0', '1.6.0-pre', '1.6.0-dev',
                '1.5.1', '1.5.1-pre', '1.5.0', '1.5.0-pre', '1.5.0-dev',
                '1.4.1', '1.4.1-pre', '1.4.0', '1.4.0-pre', '1.4.0-dev',
                '1.3.1', '1.3.1-pre', '1.3.0', '1.3.0-pre', '1.3.0-dev',
                '1.2.3', '1.2.3-pre', '1.2.2', '1.2.2-pre', '1.2.1',
                '1.2.1-pre', '1.2.0', '1.2.0-pre', '1.2.0-dev', '1.1.2',
                '1.1.2-pre', '1.1.1', '1.1.1-pre', '1.1.0', '1.1.0-pre',
                '1.1.0-dev', '1.0.1', '1.0.1-pre', '1.0.0', '1.0.0-pre',
                '1.0.0-dev',
              ]),
              static_files: 'api/update/need-newer.json',
              upload: 'api/update/need-newer\\.json'},
            {url: '/api/update/2\\.\\d+\\.\\d+-[a-z\\d]+-\\d+\\.\\d+\\.(0-dev|\\d+-pre)',
              static_files: 'api/update/unreleased.json',
              upload: 'api/update/unreleased\\.json'},
            {url: '/api/update', static_files: 'api/update/index.json',
              upload: 'api/update/index\\.json', expiration: '70d'},

            {url: '/api/voicetext', script: 'relays.voicetext'},

            {url: '/api', static_files: 'api/index.json',
              upload: 'api/index\\.json', expiration: '70d'},

            {url: '/[aA][pP][iI](/.*)?', script: 'unresolved.api'},
            {url: '.*', script: 'unresolved.other'},
        ];

        var FORCE = {secure: 'always'};

        grunt.file.write(
            'build/app.yaml',

            Array.prototype.concat(
                Object.keys(BASICS).map(function (key) {
                    var value = BASICS[key];

                    return key + ': ' +
                           (
                               typeof value === 'object' && value !== null ?

                               Object.keys(value).map(function (subkey) {
                                   return '\n  ' + subkey + ': ' +
                                          value[subkey];
                               }).join('') :

                               value
                           );
                }),
                '',
                'handlers:',
                HANDLERS.map(function (properties) {
                    Object.keys(FORCE).forEach(function (key) {
                        properties[key] = FORCE[key];
                    });

                    return ['- ', '\n'].join(
                        Object.keys(properties).map(function (key) {
                            return [
                                key,
                                typeof properties[key] === 'object' ?
                                '\n    ' + Object.keys(properties[key]).map(
                                    function (subkey) {
                                        return [
                                            subkey,
                                            properties[key][subkey],
                                        ].join(': ');
                                    }
                                ).join('\n    ') :
                                String(properties[key])
                            ].join(': ');
                        }).join('\n  ')
                    );
                })
            ).join('\n')
        );
    });


    // Deployment Key Verification (keycheck) ////////////////////////////////

    grunt.task.registerTask('keycheck', "Verify API keys.", function () {
        if (KEYS_MISSING.length) {
            grunt.fail.fatal("Missing keys for " + KEYS_MISSING.join(", "));
        } else if (KEYS_RELAYS_MISSING.length) {
            grunt.fail.fatal("Missing relay keys for " +
                             KEYS_RELAYS_MISSING.join(", "));
        } else {
            grunt.log.ok("API keys are correctly initialized.");
        }
    });


    // Set Deployment Version (version) //////////////////////////////////////

    grunt.task.registerTask('version', "Set version from git.", function () {
        var done = this.async();
        var exec = require('child_process').exec;

        var commands = {
            branch: 'git symbolic-ref --short HEAD',  // errors if detached
            tag: 'git describe --candidates=0 --tags',  // errors if untagged
            revision: 'git rev-parse --short --verify HEAD',
            dirty: 'git status --porcelain',
        };

        var keys = Object.keys(commands);

        var results = {};

        var finish = function () {
            if (['revision', 'dirty'].some(function (key) {
                return results[key].error || results[key].stderr;
            })) {
                done(false);
                return;
            }

            var version = [
                results.branch.stdout || 'detached',
                results.tag.stdout,
                results.revision.stdout,
            ].
                filter(Boolean).
                map(function (component) {
                    return component.toString().toLowerCase().
                        replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                }).
                filter(Boolean).
                join('-');

            var DIRTY = '-dirty';
            var MAX_LEN = 50;

            version = results.dirty.stdout.trim() === '' ?
                version.substr(0, MAX_LEN) :
                version.substr(0, MAX_LEN - DIRTY.length) + DIRTY;

            grunt.option('version', version);
            grunt.log.ok("Our version is " + version);
            done();
        };

        keys.forEach(function (key) {
            exec(
                commands[key],
                {timeout: 5000},
                function (error, stdout, stderr) {
                    results[key] = {error: error, stdout: stdout,
                      stderr: stderr};

                    if (keys.every(function (key) { return results[key]; })) {
                        finish();
                    }
                }
            );
        });
    });


    // Google App Engine (gae) Runner and Updater ////////////////////////////

    grunt.task.loadNpmTasks('grunt-gae');
    config.gae = {
        options: {path: 'build/'},
        run: {action: 'run', options: {async: doWatch, asyncOutput: true}},
        update: {
            action: 'update',
            options: {version: '<%= grunt.option("version") || "test" %>'},
        },
    };

    if (USE_GCLOUD_DEPLOYMENT) {
        grunt.task.registerTask('gae:update', function () {
            var done = this.async();

            var process = require('child_process').exec(
                'gcloud app deploy build/app.yaml ' +
                '--no-promote ' +
                '--quiet ' +
                '--project ankiatts ' +
                '--version ' + grunt.config.get('gae.update.options.version'),
                function (error, stdout, stderr) { done(!error); }
            );
            process.stdout.on('data', grunt.log.write);
            process.stderr.on('data', grunt.log.error);
        });
    }


    // Watcher (watch) ///////////////////////////////////////////////////////

    grunt.task.loadNpmTasks('grunt-contrib-watch');
    config.watch = {
        options: {spawn: false},  // required for grunt.event.on logic to work

        grunt: {files: ['Gruntfile.js', 'keys.json', 'sitemap.json'],
          tasks: 'build', options: {reload: true}},

        favicon: {files: 'favicon.ico', tasks: 'copy:favicon'},
        touchIcon: {files: 'apple-touch-icon.png', tasks: 'copy:touchIcon'},
        images: {files: 'images/*.{gif,png}', tasks: 'copy:images'},
        robots: {files: 'robots.txt', tasks: 'copy:robots'},
        dntPolicy: {files: 'dnt-policy.txt', tasks: 'copy:dntPolicy'},
        relaysPy: {files: 'relays/__init__.py',
                   tasks: 'mustache_render:relaysPy'},
        unresolvedPy: {files: 'unresolved/__init__.py',
          tasks: 'copy:unresolvedPy'},

        api: {files: 'api/**/*.json', tasks: ['copy:api', 'json-minify:api']},

        style: {files: 'style.scss', tasks: ['sass:style', 'cssmin:style']},

        toplevels: {files: ['pages/*.mustache', 'pages/*/index.mustache'],
          tasks: ['mustache_render:pages', 'replace:toplevels', 'htmlmin:pages']},
        secondaries: {files: ['pages/*/*.mustache', '!pages/*/index.mustache'],
          tasks: ['mustache_render:pages', 'replace:secondaries', 'htmlmin:pages']},

        // these re-copy the "unresolved" module so its cached HTML is cleared
        partials: {files: 'partials/*.mustache',
          tasks: [
            'mustache_render:pages',
            'mustache_render:unresolvedError404',
            'mustache_render:unresolvedRedirect',
            'htmlmin:pages',
            'htmlmin:unresolvedError404',
            'htmlmin:unresolvedRedirect',
            'copy:unresolvedPy',
          ]},
        redirects: {files: 'redirects.json', tasks: ['copy:redirects',
          'copy:unresolvedPy']},
        unresolvedError404: {files: 'unresolved/error404.mustache',
          tasks: [
            'mustache_render:unresolvedError404',
            'htmlmin:unresolvedError404',
            'copy:unresolvedPy',
          ]},
        unresolvedRedirect: {files: 'unresolved/redirect.mustache',
          tasks: [
            'mustache_render:unresolvedRedirect',
            'htmlmin:unresolvedRedirect',
            'copy:unresolvedPy',
          ]},
    };

    (function () {
        var OLD_VALUES = {};
        ['copy.images.src', 'copy.api.src', 'json-minify.api.files',
          'mustache_render.pages.files', 'replace.toplevels.files.0.src',
          'replace.secondaries.files.0.src', 'htmlmin.pages.src'].
            forEach(function (key) { OLD_VALUES[key] = grunt.config(key); });

        grunt.event.on('watch', function (action, path, target) {
            // n.b. doing a reset here preps any task that has had its
            // configuration clobbered by a related task (e.g. watch:pages
            // clobbers the mustache_render.pages.files list, but if
            // watch:partials kicks off, then that full list needs to be
            // in-place to rebuild all pages).
            Object.keys(OLD_VALUES).forEach(function (key) {
                grunt.config(key, OLD_VALUES[key]);
            });

            if (action === 'changed' || action === 'added') {
                switch (target) {
                    case 'images':
                        grunt.config('copy.images.src', path);
                        break;

                    case 'api':
                        grunt.config('copy.api.src', path);
                        grunt.config('json-minify.api.files', 'build/' + path);
                        break;

                    case 'toplevels':
                    case 'secondaries':
                        grunt.config(
                            'mustache_render.pages.files',
                            OLD_VALUES['mustache_render.pages.files'].
                                filter(function (file) {
                                    return file.template === path;
                                })
                        );
                        grunt.config(
                            ['replace.', '.files.0.src'].join(target),
                            path.replace(/\.mustache$/, '.html')
                        );
                        grunt.config(
                            'htmlmin.pages.src',
                            path.replace(/\.mustache$/, '.html')
                        );
                        break;
                }
            } else {
                grunt.fail.fatal(action + " not supported; please reload");
                process.exit();
            }
        });
    }());
};
