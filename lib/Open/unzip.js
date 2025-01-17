var Promise = require('bluebird');
var Decrypt = require('../Decrypt');
var PullStream = require('../PullStream');
var Stream = require('stream');
var binary = require('binary');
var zlib = require('zlib');
var parseExtraField = require('../parseExtraField');
var Buffer = require('../Buffer');
var parseDateTime = require('../parseDateTime');

// Backwards compatibility for node versions < 8
if (!Stream.Writable || !Stream.Writable.prototype.destroy) Stream = require('readable-stream');

module.exports = function unzip(source, offset, _password, directoryVars) {
    var file = PullStream(),
        entry = Stream.PassThrough();

    var req = source.stream(offset);
    console.log('Created source stream');

    req.pipe(file).on('error', function (e) {
        entry.emit('error', e);
    });
    console.log('Setup error emitter');

    // CP: pull 30 bytes from the LOCAL FILE HEADER
    entry.vars = file
        .pull(30)
        .then(function (data) {
            var vars = binary
                .parse(data)
                .word32lu('signature')
                .word16lu('versionsNeededToExtract')
                .word16lu('flags')
                .word16lu('compressionMethod')
                .word16lu('lastModifiedTime')
                .word16lu('lastModifiedDate')
                .word32lu('crc32')
                .word32lu('compressedSize')
                .word32lu('uncompressedSize')
                .word16lu('fileNameLength')
                .word16lu('extraFieldLength').vars;

            // CP
            console.log('Successfully pulled local file header');
            vars.lastModifiedDateTime = parseDateTime(vars.lastModifiedDate, vars.lastModifiedTime);

            // CP: pull variable length filename from the LOCAL FILE HEADER
            return file
                .pull(vars.fileNameLength)
                .then(function (fileName) {
                    // CP
                    console.log('Successfully pulled filename');
                    vars.fileName = fileName.toString('utf8');
                    // CP: pull variable length extra field from the LOCAL FILE HEADER
                    return file.pull(vars.extraFieldLength);
                })
                .then(function (extraField) {
                    // CP
                    console.log('Successfully pulled local file header');
                    var checkEncryption;
                    vars.extra = parseExtraField(extraField, vars);
                    // Ignore logal file header vars if the directory vars are available
                    // CP: directory vars are not available when using our straight-to-file extraction using the offset
                    if (directoryVars && directoryVars.compressedSize) vars = directoryVars;

                    // CP: if encryption bit is set, there is a 12 bye ENCRYPTION HEADER before the file
                    if (vars.flags & 0x01)
                        checkEncryption = file.pull(12).then(function (header) {
                            // CP
                            console.log('Successfully pulled encryption header');
                            if (!_password) throw new Error('MISSING_PASSWORD');

                            var decrypt = Decrypt();

                            String(_password)
                                .split('')
                                .forEach(function (d) {
                                    decrypt.update(d);
                                });

                            for (var i = 0; i < header.length; i++) header[i] = decrypt.decryptByte(header[i]);

                            vars.decrypt = decrypt;
                            vars.compressedSize -= 12;

                            var check =
                                vars.flags & 0x8 ? (vars.lastModifiedTime >> 8) & 0xff : (vars.crc32 >> 24) & 0xff;
                            if (header[11] !== check) throw new Error('BAD_PASSWORD');

                            return vars;
                        });

                    return Promise.resolve(checkEncryption).then(function () {
                        entry.emit('vars', vars);
                        return vars;
                    });
                });
        })
        .catch((e) => {
            // CP
            console.log('ERROR IN FILE HEADER PULL', e);
            rethrow(e);
        });

    entry.vars
        .then(function (vars) {
            console.log('Starting processing env vars');
            var fileSizeKnown = !(vars.flags & 0x08) || vars.compressedSize > 0,
                eof;

            var inflater = vars.compressionMethod ? zlib.createInflateRaw() : Stream.PassThrough();

            // CP
            console.log(`fileSizeKnown: ${fileSizeKnown}, uncompressedSize: ${vars.uncompressedSize}`);
            if (fileSizeKnown) {
                entry.size = vars.uncompressedSize;
                eof = vars.compressedSize;
            } else {
                eof = Buffer.alloc(4);
                eof.writeUInt32LE(0x08074b50, 0);
            }

            var stream = file.stream(eof);

            if (vars.decrypt) stream = stream.pipe(vars.decrypt.stream());

            stream
                .pipe(inflater)
                .on('error', function (err) {
                    entry.emit('error', err);
                })
                .pipe(entry)
                .on('finish', function () {
                    if (req.abort) req.abort();
                    else if (req.close) req.close();
                    else if (req.push) req.push();
                    else console.log('warning - unable to close stream');
                });
        })
        .catch(function (e) {
            entry.emit('error', e);
        });

    return entry;
};
