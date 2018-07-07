'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import * as github from '@octokit/rest';
import * as os from 'os';
import * as mkdirp from 'mkdirp';
import * as fs from 'fs';
import * as decompress from 'decompress';
import * as request from 'request';
import * as request_progress from 'request-progress';
import * as url_exists from 'url-exists';
//import * as compare_versions from 'compare-versions';
import compare_versions = require('compare-versions');
import * as child_process from 'child_process';

export function cmakeArchBits(): number {
    const archName = os.arch();
    switch (archName) {
        case 'x64':
            return 64;
        case 'x32':
            return 32;
        case 'x86':
            return 32;
    }
}

// @return ['exact platform name', 'fallback name 1', 'fallback name 2']
export function cmakePlatformNames(): string[] {
    const archBits = cmakeArchBits();
    const osName   = os.type();
    switch (osName) {
        case 'Linux':
            if (archBits == 64) {
                return ['Linux-x86_64', 'Linux-i386'];
            } else {
                return ['Linux-i386'];
            }

        case 'Darwin':
            if (archBits == 64) {
                return ['Darwin-x86_64', 'Darwin64-universal', 'Darwin-universal'];
            } else {
                return ['Darwin-universal'];
            }

        case 'Windows_NT':
            if (archBits == 64) {
                return ['win64-x64', 'win32-x86'];
            } else {
                return ['win32-x86'];
            }

        default:
            throw 'Unsupported OS [' + osName + ']';
    }
}

export function cmakePlatformExtension(): string {
    const osName   = os.type();
    switch (osName) {
        case 'Linux':
            return '.tar.gz';

        case 'Darwin':
            return '.tar.gz';

        case 'Windows_NT':
            return '.zip';

        default:
            throw 'Unsupported OS [' + osName + ']';
    }
}

export function makeConfigName(projectName: string, targetName: string, buildTypeName: string): string {
    if (projectName == null || targetName == null || buildTypeName == null) {
        return 'null';
    }
    else {
        return `${projectName} / ${targetName} / ${buildTypeName}`;
    }
}

export function vscodeFolderPath(): string {
    return path.join(vscode.workspace.rootPath || '~', '.vscode');
}

export function initCMakeDownloadDir() {
    let cmakeDlPath = vscode.workspace.getConfiguration('cmake-tools-helper').get<string>('cmake_download_path');
    if (cmakeDlPath == null) {
        const extPath = vscode.extensions.getExtension("SonglinPiao.cmake-tools-helper").extensionPath;
        const cmakeDlPath = extPath + path.sep + 'cmake_download';
        vscode.workspace.getConfiguration('cmake-tools-helper').update('cmake_download_path', cmakeDlPath, true);
    }

    if (!fs.existsSync(cmakeDlPath)) {
        mkdirp.sync(cmakeDlPath);
        if (!fs.existsSync(cmakeDlPath)) {
            const msg = `Fail: Creation of cmakeDlPath:${cmakeDlPath}`;
            console.error(msg);
            vscode.window.showErrorMessage(msg);
            return;
        }
    }

    console.log(`cmake-tools-helper.cmake_download_path:${cmakeDlPath}`);
}

export function installCMake() {
    getRemoteCMakeVersionNames(async (remoteVersions: string[]) => {
        remoteVersions.sort().reverse();
        const versionToDownload = await vscode.window.showQuickPick(remoteVersions, {
            matchOnDescription: true,
            matchOnDetail: true,
            placeHolder: 'Choose a CMake version to download and install',
            ignoreFocusOut: true
        });
        if (versionToDownload == null) {
            return null;
        }

        downloadAndInstallCMake(versionToDownload, async (installedCMakeRootDir) => {
            if (installedCMakeRootDir == null) {
                console.error(`Failed to download CMake ${versionToDownload}`)
                return null;
            }
            const installedCMakePath = `${installedCMakeRootDir}${path.sep}bin${path.sep}cmake`;

            const currentCMakePath = vscode.workspace.getConfiguration('cmake').get<string>('cmakePath');
            const msg = `CMake ${versionToDownload} installed in ${installedCMakeRootDir}`;
            console.log(msg);
            const setCMakePath = await vscode.window.showQuickPick([
                {
                    label: 'Yes',
                    description: `Set "cmake.cmakePath": "${installedCMakePath}"`
                }, {
                    label: 'No',
                    description: `Keep "cmake.cmakePath": "${currentCMakePath}"`
                }
            ], {
                    matchOnDescription: true,
                    matchOnDetail: true,
                    placeHolder: 'Update cmake.cmakePath ?',
                    ignoreFocusOut: true
                });

            if (setCMakePath.label == 'Yes') {
                await vscode.workspace.getConfiguration('cmake').update('cmakePath', `${installedCMakePath}`, true);
                const useCMakeServer = compare_versions(versionToDownload, '3.7.1') > 0;
                await vscode.workspace.getConfiguration('cmake').update('useCMakeServer', useCMakeServer, true);

                vscode.window.showInformationMessage(`CMake Tools will use CMake ${versionToDownload} after restarting Visual Studio Code`);
            }
        });
    });
}

export function getRemoteCMakeVersionNames(onReceivedTagsCB) {
    let ghClient = new github({
        headers: {
            // https://developer.github.com/v3/#user-agent-required
            'user-agent': 'vscode'
            //, 'Authorization': 'token MY_SECRET_TOKEN'  // TODO remove me
        }
    });

    let tags: string[] = [];

    const getTags = (err, res) => {
        if (err) {
            return false;
        }

        Array.prototype.push.apply(tags, res.data.map(t => t.ref));
        if (ghClient.hasNextPage(res)) {
            ghClient.getNextPage(res, (err, res) => { return getTags(err, res); })
        } else {
            onReceivedTagsCB(tags.map(t => t.replace('refs/tags/', '')));
        }
    }

    ghClient.gitdata.getTags({
            owner: 'Kitware',
            repo: 'CMake'
        },
        (err, res) => {
            getTags(err, res);
        }
    );
}

export function downloadAndInstallCMake(versionName: string, onDownloadInstallFinish) {
    const versionNumber  = versionName.replace(/^v/, '');
    const versionArray   = versionNumber.split('.');
    const versionMajor   = versionArray[0];
    const versionMinor   = versionArray[1];
    const versionDirUrl  = `http://cmake.org/files/v${versionMajor}.${versionMinor}/`;

    const fileNameBase = `cmake-${versionNumber}-`;
    const downloadPath = vscode.workspace.getConfiguration('cmake-tools-helper').get<string>('cmake_download_path').replace(/[\/\\]+$/, '');

    downloadAndInstallCMake_actual(
        versionDirUrl, versionNumber, cmakePlatformNames(), cmakePlatformExtension(),
        downloadPath,
        onDownloadInstallFinish);
}

export function downloadAndInstallCMake_actual(
    versionDirUrl: string, versionNumber: string, platformNames: string[], platformExt: string,
    downloadPath: string,
    onDownloadInstallFinish) {

    if (platformNames.length < 1) {
        vscode.window.showErrorMessage('Failed to find valid precompiled CMake archives for your platform');
        return;
    }

    const fileNameBase = `cmake-${versionNumber}-`;
    const fileName     = `${fileNameBase}${platformNames[0]}${platformExt}`;

    const fileUrl  = `${versionDirUrl}${fileName}`;
    const filePath = `${downloadPath}${path.sep}${fileName}`;

    const tryMsg = `Trying to download ${fileUrl}`;
    console.log(tryMsg);
    vscode.window.setStatusBarMessage(tryMsg, 4000);

    url_exists(fileUrl, (err, exists) => {
        if (!exists) {
            const errMsg = `The precompiled CMake archive [${fileUrl}] does not exist [Error: ${err}]`;
            console.error(errMsg);
            vscode.window.setStatusBarMessage(errMsg, 4000);
            platformNames.shift();
            downloadAndInstallCMake_actual(
                versionDirUrl, versionNumber, platformNames, platformExt,
                downloadPath,
                onDownloadInstallFinish);
        } else {
            // The options argument is optional so you can omit it
            return request_progress(request(fileUrl), {
                // throttle: 2000,                    // Throttle the progress event to 2000ms, defaults to 1000ms
                // delay: 1000,                       // Only start to emit after 1000ms delay, defaults to 0ms
                // lengthHeader: 'x-transfer-length'  // Length header to use, defaults to content-length
            })
            .on('progress', state => {
                // The state is an object that looks like this:
                // {
                //     percent: 0.5,               // Overall percent (between 0 to 1)
                //     speed: 554732,              // The download speed in bytes/sec
                //     size: {
                //         total: 90044871,        // The total payload size in bytes
                //         transferred: 27610959   // The transferred payload size in bytes
                //     },
                //     time: {
                //         elapsed: 36.235,        // The total elapsed seconds since the start (3 decimals)
                //         remaining: 81.403       // The remaining seconds to finish (3 decimals)
                //     }
                // }
                console.log('CMake Download ', state);
                const progPercent = (state.percent * 100.0).toFixed(2) + '%';
                const progSpeed = (state.speed / 1024).toFixed(2) + ' Kib/s';
                vscode.window.setStatusBarMessage(`CMake Download ${progPercent} @ ${progSpeed}`, 4000);
            })
            .on('error', e => {
                // Do something with err
                const errMsg = `Error when downloading ${fileUrl}. ${e}`;
                console.error(errMsg);
                vscode.window.showErrorMessage(errMsg);
            })
            .on('end', () => {
                // Do something after request finishes
                vscode.window.setStatusBarMessage('CMake Download Finished. Extracting...', 4000);
                decompress(filePath, path.dirname(filePath)).then(async extractedData => {
                    fs.unlinkSync(filePath);

                    const extractionDir = extractedData[0].path.split(/[\/\\]/)[0];  // keep only the first "component" of the path
                    const extractionPath = `${downloadPath}${path.sep}${extractionDir}`;

                    const okMsg = `CMake v${versionNumber} installed in ${extractionPath}`;
                    console.log(okMsg);
                    vscode.window.setStatusBarMessage(okMsg, 4000);

                    await onDownloadInstallFinish(extractionPath);
                });
            })
            .pipe(fs.createWriteStream(filePath));
        }
    });
}

export async function changeCMakeVersion() {
    const installedCMakes = getInstalledCMakeVersions();
    if (installedCMakes == null) {
        vscode.window.showErrorMessage('You have not installed any version of CMake. Make sure that you have run "Install CMake" at least once');
        return;
    }

    const installedCMakesQuickPick = installedCMakes.map(cm => {
        return {
            label: `v${cm.version}`,
            description: `${cm.path}`
        };
    })
    const cmakeVersion = await vscode.window.showQuickPick(installedCMakesQuickPick, {
        matchOnDescription: true,
        matchOnDetail: true,
        placeHolder: 'Choose a CMake version to use with CMake Tools',
        ignoreFocusOut: true
    });
    if (cmakeVersion == null) {
        return;
    }

    await vscode.workspace.getConfiguration('cmake').update('cmakePath', path.join(cmakeVersion.description, 'bin', 'cmake'), true);
    const useCMakeServer = (() => {
        try {
            return compare_versions(cmakeVersion.label, '3.7.1') > 0;  // fails if rhs is not a valid SemVer
        } catch (e) {
            console.error('compare_versions(cmakeVersion.label, \'3.7.1\') failed [cmakeVersion.label:' + `${cmakeVersion.label}` + ']');
            return false;
        }
    })();
    await vscode.workspace.getConfiguration('cmake').update('useCMakeServer', useCMakeServer, true);

    vscode.window.showInformationMessage(`CMake Tools will use CMake ${cmakeVersion.label} after restarting Visual Studio Code`);
}

export function getInstalledCMakeVersions() {
    const cmakeDlPath = vscode.workspace.getConfiguration('cmake-tools-helper').get<string>('cmake_download_path');
    if (cmakeDlPath == null) {
        vscode.window.showErrorMessage('Please configure "cmake-tools-helper.cmake_download_path"');
        return null;
    }

    const cmakeDirs = fs.readdirSync(cmakeDlPath).filter(file => fs.lstatSync(path.join(cmakeDlPath, file)).isDirectory());
    if (cmakeDirs == null || cmakeDirs.length < 1) {
        return null;
    }

    return cmakeDirs.map(d => {
        const absPath = path.join(cmakeDlPath, d);
        return {
            version: computeCMakeVersion(absPath),
            path: absPath
        }
    });
}

export function computeCMakeVersion(cmakeInstallDir: string): string {
    const cmd = `"${cmakeInstallDir}${path.sep}bin${path.sep}cmake" --version`;
    const cmakeOutput = child_process.execSync(cmd).toString();
    // sample outputs: (obtained after some trial&error)
    //  cmake version 2.4-patch 2 (the last "2" won't be matched...)
    //  cmake version 3.9.0-rc1
    //  cmake version 3.5.1
    const cmakeVersion = cmakeOutput.match(/cmake\s+version\s+([0-9]+\.[0-9]+(\.[0-9]+)?\S*)/i);
    if (cmakeVersion == null || cmakeVersion.length < 2) {
        return null;
    }
    return cmakeVersion[1];
}