/*---------------------------------------------------------
 * Copyright (C) Xored Software Inc. All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------*/

'use strict';

import vscode = require('vscode');
import cp = require('child_process');
import path = require('path');
import os = require('os');
import fs = require('fs');
import net = require('net');
import elrpc = require('elrpc');
import elparser = require('elparser');
import { prepareConfig, getProjectFile, isProjectMode, getNimExecPath, removeDirSync, correctBinname } from './nimUtils';
import { hideNimStatus, showNimStatus } from './nimStatus';

class NimSuggestProcessDescription {
    process: cp.ChildProcess;
    //rpc: elrpc.RPCServer;
    port: number;
    failCounter: number;
}

let nimSuggestProcessCache: { [project: string]: PromiseLike<NimSuggestProcessDescription> } = {};
var _nimSuggestPath: string = undefined;

export enum NimSuggestType {
    /** Suggest from position */
    sug,
    /** Get context from position */
    con,
    /** Get symbol definition from position */
    def,
    /** Get references of symbol from position */
    use,
    /** Get usage of symbol from position in project */
    dus,
    /** Ivoke nim check on file */
    chk,
    /** Returns all tokens in file (symbolType, line, pos, lenght) */
    highlight,
    /** Get outline symbols for file */
    outline
}
/**
 * Parsed string line from nimsuggest utility.
 */
export class NimSuggestResult {

    /** Three characters indicating the type of returned answer 
     * (e.g. def for definition, sug for suggestion, etc). */
    answerType: string;

    /** Type of the symbol. This can be skProc, skLet, and just
     *  about any of the enums defined in the module compiler/ast.nim. */
    suggest: string;

    /** Full qualitifed path of the symbol.If you are querying a symbol 
     * defined in the proj.nim file, this would have the form [proj, symbolName]. */
    names: string[];

    /** Type / signature.For variables and enums this will contain the type 
     * of the symbol, for procs, methods and templates this will contain the 
     * full unique signature (e.g.proc(File)). */
    type: string;

    /** Full path to the file containing the symbol. */
    path: string;

    /** Line where the symbol is located in the file.Lines start to count at 1. */
    line: number;

    /** Column where the symbol is located in the file.Columns start to count at 0. */
    column: number;

    /** Docstring for the symbol if available or the empty string.
     * To differentiate the docstring from end of answer in server mode, 
     * the docstring is always provided enclosed in double quotes, and if 
     * the docstring spans multiple lines, all following lines of the docstring 
     * will start with a blank space to align visually with the starting quote.
     * //
     * Also, you won't find raw \n characters breaking the one answer per line format.
     * Instead you will need to parse sequences in the form \xHH, where HH 
     * is a hexadecimal value (e.g. newlines generate the sequence \x0A). */
    documentation: string;

    get range(): vscode.Range {
        return new vscode.Range(this.line - 1, this.column, this.line - 1, this.column);
    }

    get position(): vscode.Position {
        return new vscode.Position(this.line - 1, this.column);
    }

    get uri(): vscode.Uri {
        return vscode.Uri.file(this.path);
    }

    get location(): vscode.Location {
        return new vscode.Location(this.uri, this.position);
    }

    get fullName(): string {
        return this.names ? this.names.join('.') : '';
    }

    get symbolName(): string {
        return this.names ? this.names[this.names.length - 1] : '';
    }

    get moduleName(): string {
        return this.names ? this.names[0] : '';
    }

    get containerName(): string {
        return this.names ? this.names.slice(0, this.names.length - 1).join('.') : '';
    }
}

export function getNimSuggestPath(): string {
    return _nimSuggestPath;
}

export function initNimSuggest(ctx: vscode.ExtensionContext) {
    prepareConfig();
    // let check nimsuggest related nim executable
    let nimSuggestNewPath = path.resolve(path.dirname(getNimExecPath()), correctBinname('nimsuggest'));
    if (fs.existsSync(nimSuggestNewPath)) {
        _nimSuggestPath = nimSuggestNewPath;
        return;
    }
    vscode.workspace.onDidChangeConfiguration(prepareConfig);
    let extensionPath = ctx.extensionPath;
    var nimSuggestDir = path.resolve(extensionPath, 'nimsuggest');
    var nimSuggestSourceFile = path.resolve(nimSuggestDir, 'nimsuggest.nim');
    var execFile = path.resolve(nimSuggestDir, correctBinname('nimsuggest'));
    var nimExecTimestamp = fs.statSync(getNimExecPath()).mtime.getTime();
    var nimSuggestTimestamp = fs.statSync(nimSuggestSourceFile).mtime.getTime();

    if (fs.existsSync(execFile) && ctx.globalState.get('nimExecTimestamp', 0) === nimExecTimestamp &&
        ctx.globalState.get('nimSuggestTimestamp', 0) === nimSuggestTimestamp) {
        _nimSuggestPath = execFile;
    } else {
        let nimCacheDir = path.resolve(nimSuggestDir, 'nimcache');
        if (fs.existsSync(nimCacheDir)) {
            removeDirSync(nimCacheDir);
        }
        let cmd = '"' + getNimExecPath() + '" c -d:release --path:"' + path.dirname(path.dirname(getNimExecPath())) + '" nimsuggest.nim';
        showNimStatus('Compiling nimsuggest', '');
        cp.exec(cmd, { cwd: nimSuggestDir }, (error, stdout, stderr) => {
            hideNimStatus();

            if (error) {
                vscode.window.showWarningMessage('Cannot compile nimsuggest. See console log for details');
                console.log(error);
                return;
            }
            if (stderr && stderr.length > 0) {
                console.error(stderr);
            }
            _nimSuggestPath = execFile;
            ctx.globalState.update('nimExecTimestamp', nimExecTimestamp);
            ctx.globalState.update('nimSuggestTimestamp', nimSuggestTimestamp);
        });
    }
}

function trace(pid: number, projectFile: string, msg: any): void {
    if (!!vscode.workspace.getConfiguration('nim').get('logNimsuggest')) {
        console.log('[' + pid + ':' + projectFile + ']');
        console.log(msg);
    }
}

export async function execNimSuggest(suggestType: NimSuggestType, filename: string,
    line: number, column: number, dirtyFile?: string, onClose?: () => void): Promise<NimSuggestResult[]> {
    var nimSuggestExec = getNimSuggestPath();
    // if nimsuggest not found just ignore
    if (!nimSuggestExec) {
        return [];
    }
    try {
        let projectFile = getProjectFile(filename);
        let normalizedFilename = filename.replace(/\\+/g, '/');
        let desc = await getNimSuggestProcess(projectFile);
        trace(desc.process.pid, projectFile, NimSuggestType[suggestType] + ' ' + normalizedFilename + ':' + line + ':' + column);

        let cmd = NimSuggestType[suggestType] + ' "' + filename + '"' + (dirtyFile ? (';"' + dirtyFile + '"') : "") + ":" + line + ":" + column + "\n";
        let str = "";
        let resolved = false;

        return new Promise<NimSuggestResult[]>((resolve, reject) => {
            let socket = net.createConnection(desc.port, "127.0.0.1", () => {
                socket.end(cmd);
            });

            socket.on('data', data => { str += data.toString(); });
            socket.on('error', err => {
                if (err.message === "ECONNREFUSED") {
                    if (!!nimSuggestProcessCache[projectFile]) {
                        desc.failCounter++;
                        if (desc.failCounter > 5) {
                            closeNimSuggestProcess(filename);
                        }
                    }

                    resolved = true;
                    resolve([]);
                }
            });
            socket.on('end', () => {
                resolved = true;

                let result: NimSuggestResult[] = [];
                let lines = str.split(os.EOL);

                lines.forEach(line => {
                    let parts = line.split('\t');
                    if (parts.length >= 8) {
                        var item = new NimSuggestResult();
                        item.answerType = parts[0];
                        item.suggest = parts[1];
                        item.names = [/(.+)\..+/.exec(parts[2])[1], /.+\.(.+)/.exec(parts[2])[1]];
                        item.type = parts[3];
                        item.path = parts[4].replace(/\\,\\/g, '\\');
                        item.line = parseInt(parts[5]);
                        item.column = parseInt(parts[6]);
                        var doc = parts[7].substring(1, parts[7].length - 1);
                        if (doc !== '') {
                            doc = doc.replace(/\\x0A|\\x0D\\x0A/g, '\n');
                            doc = doc.replace(/\`\`/g, '`');
                            doc = doc.replace(/\`([^\<\`]+)\<([^\>]+)\>\`\_/g, '\[$1\]\($2\)');
                        }
                        item.documentation = doc;
                        result.push(item);
                    }

                });

                socket.destroy();

                if (!isProjectMode() && vscode.window.visibleTextEditors.every(
                    (value, index, array) => { return value.document.uri.fsPath !== filename; })
                )
                    closeNimSuggestProcess(filename);

                resolve(result);
            });
            socket.on('close', () => { if (onClose) { onClose(); } });
        });
    } catch (e) {
        console.error(e);
        await closeNimSuggestProcess(filename);
    }
}

export async function closeAllNimSuggestProcesses(): Promise<void> {
    for (var project in nimSuggestProcessCache) {
        let desc = await nimSuggestProcessCache[project];
        //desc.rpc.stop();
        desc.process.kill();
    }
    nimSuggestProcessCache = {};
}

export async function closeNimSuggestProcess(filename: string): Promise<void> {
    var file = getProjectFile(filename);
    if (nimSuggestProcessCache[file]) {
        let desc = await nimSuggestProcessCache[file];
        desc.process.kill();
        nimSuggestProcessCache[file] = undefined;
    }
}

let portCounter = 6000;
async function getNimSuggestProcess(nimProject: string): Promise<NimSuggestProcessDescription> {
    if (!nimSuggestProcessCache[nimProject]) {
        nimSuggestProcessCache[nimProject] = new Promise<NimSuggestProcessDescription>((resolve, reject) => {
            let port = portCounter++;
            var args = ['--port:' + port, '--v2', '--address:127.0.0.1'];
            if (!!vscode.workspace.getConfiguration('nim').get('logNimsuggest')) {
                args.push('--log');
            }
            args.push(nimProject);
            let process = cp.spawn(getNimSuggestPath(), args, { cwd: vscode.workspace.rootPath });

            process.on('close', () => {
                reject();
            });

            //return { process: process, port: port };
            resolve({ process: process, port: port, failCounter: 0 });
        });
    }
    return nimSuggestProcessCache[nimProject];
}
