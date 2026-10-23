#!/usr/bin/env node

var fs = require('fs');
var path = require('path');

var playlistPath = process.argv[2] || path.join(__dirname, '..', 'playlists', 'index.country.m3u');
var text;

try {
    text = fs.readFileSync(playlistPath, 'utf8');
} catch (error) {
    console.error('Could not read playlist:', error.message);
    process.exitCode = 1;
    return;
}

var lines = text.split(/\r?\n/);
var entries = 0;
var malformed = 0;
var pending = false;

lines.forEach(function (rawLine) {
    var line = rawLine.trim();
    if (!line) return;
    if (line.indexOf('#EXTINF') === 0) {
        if (pending) malformed++;
        entries++;
        pending = true;
        return;
    }
    if (pending && line.charAt(0) !== '#') pending = false;
});

if (pending) malformed++;
if (!entries || malformed) {
    console.error('Playlist validation failed: ' + entries + ' entries, ' + malformed + ' incomplete entry.');
    process.exitCode = 1;
    return;
}

console.log('Playlist valid: ' + entries + ' channels.');
