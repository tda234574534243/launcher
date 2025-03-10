import { ExtConfigFile } from '@back/ExtConfigFile';
import { DisposableChildProcess, ManagedChildProcess } from '@back/ManagedChildProcess';
import { EXT_CONFIG_FILENAME, PREFERENCES_FILENAME } from '@back/constants';
import { loadCurationIndexImage } from '@back/curate/parse';
import { duplicateCuration, genCurationWarnings, makeCurationFromGame, refreshCurationContent } from '@back/curate/util';
import { saveCuration } from '@back/curate/write';
import { downloadGameData } from '@back/download';
import { genContentTree } from '@back/rust';
import { BackState, StatusState } from '@back/types';
import { pathTo7zBack } from '@back/util/SevenZip';
import { awaitDialog } from '@back/util/dialog';
import { clearDisposable, dispose, newDisposable, registerDisposable } from '@back/util/lifecycle';
import {
  deleteCuration,
  getOpenMessageBoxFunc,
  getOpenOpenDialogFunc,
  getOpenSaveDialogFunc,
  removeService,
  runService,
  setStatus
} from '@back/util/misc';
import { BrowsePageLayout, ScreenshotPreviewMode } from '@shared/BrowsePageLayout';
import { ILogEntry, LogLevel } from '@shared/Log/interface';
import { BackOut, FpfssUser } from '@shared/back/types';
import { CURATIONS_FOLDER_WORKING } from '@shared/constants';
import { CurationMeta } from '@shared/curate/types';
import { getContentFolderByKey } from '@shared/curate/util';
import { CurationTemplate, IExtensionManifest } from '@shared/extensions/interfaces';
import { ProcessState, Task } from '@shared/interfaces';
import { PreferencesFile } from '@shared/preferences/PreferencesFile';
import { overwritePreferenceData } from '@shared/preferences/util';
import { formatString } from '@shared/utils/StringFormatter';
import * as flashpoint from 'flashpoint-launcher';
import { Game } from 'flashpoint-launcher';
import * as fs from 'fs';
import * as fsExtra from 'fs-extra';
import { extractFull } from 'node-7z';
import * as path from 'path';
import { fpDatabase, loadCurationArchive } from '..';
import { addPlaylistGame, deletePlaylist, deletePlaylistGame, filterPlaylists, findPlaylist, findPlaylistByName, getPlaylistGame, savePlaylistGame, updatePlaylist } from '../playlist';
import { newExtLog } from './ExtensionUtils';
import { Command, RegisteredMiddleware } from './types';
import * as uuid from 'uuid';
import * as stream from 'stream';

/**
 * Create a Flashpoint API implementation specific to an extension, used during module load interception
 *
 * @param extId Extension ID
 * @param extManifest Manifest of the caller
 * @param addExtLog Function to add an Extensions log to the Logs page
 * @param version Version of the Flashpoint Launcher
 * @param state Back State
 * @param extPath Folder Path to the Extension
 * @returns API Implementation specific to the caller
 */
export function createApiFactory(extId: string, extManifest: IExtensionManifest, addExtLog: (log: ILogEntry) => void, version: string, state: BackState, extPath?: string): typeof flashpoint {
  const { registry, apiEmitters } = state;

  const getPreferences = () => state.preferences;
  const extOverwritePreferenceData = async (
    data: flashpoint.DeepPartial<flashpoint.AppPreferencesData>,
    onError?: (error: string) => void
  ) => {
    overwritePreferenceData(state.preferences, data, onError);
    await PreferencesFile.saveFile(path.join(state.configFolder, PREFERENCES_FILENAME), state.preferences, state);
    state.socketServer.broadcast(BackOut.UPDATE_PREFERENCES_RESPONSE, state.preferences);
    return state.preferences;
  };

  const unloadExtension = () => state.extensionsService.unloadExtension(extId);

  const reloadExtension = () => {
    setTimeout(() => {
      state.extensionsService.unloadExtension(extId).then(() => {
        console.log(`Back - attempting reload for ${extId}`);
        state.extensionsService.loadExtension(extId);
      });
    }, 10);
  };

  const getExtensionFileURL = (filePath: string): string => {
    return `http://localhost:${state.fileServerPort}/extdata/${extId}/${filePath}`;
  };

  const unzipFile = (filePath: string, outDir: string, opts?: flashpoint.ZipExtractOptions): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      const { onProgress, onData } = opts || {};
      const readable = extractFull(filePath, outDir, { $bin: pathTo7zBack(state.isDev, state.exePath), $progress: onProgress !== undefined });
      readable.on('end', () => {
        resolve();
      });
      if (onProgress) { readable.on('progress', onProgress); }
      if (onData) { readable.on('data', onData); }
      readable.on('error', (err) => {
        reject(err);
      });
    });
  };

  const getExtConfigValue = (key: string): any => {
    return state.extConfig[key];
  };

  const setExtConfigValue = async (key: string, value: any): Promise<void> => {
    state.extConfig[key] = value;
    await ExtConfigFile.saveFile(path.join(state.config.flashpointPath, EXT_CONFIG_FILENAME), state.extConfig);
    state.socketServer.broadcast(BackOut.UPDATE_EXT_CONFIG_DATA, state.extConfig);
  };

  const focusWindow = () => {
    state.socketServer.broadcast(BackOut.FOCUS_WINDOW);
  };

  // Log Namespace
  const extLog: typeof flashpoint.log = {
    trace: (message: string) => addExtLog(newExtLog(extManifest, message, log.trace)),
    debug: (message: string) => addExtLog(newExtLog(extManifest, message, log.debug)),
    info:  (message: string) => addExtLog(newExtLog(extManifest, message, log.info)),
    warn:  (message: string) => addExtLog(newExtLog(extManifest, message, log.warn)),
    error: (message: string) => addExtLog(newExtLog(extManifest, message, log.error)),
    onLog: state.apiEmitters.onLog.extEvent(extManifest.displayName || extManifest.name),
  };

  // Commands Namespace
  const extCommands: typeof flashpoint.commands = {
    registerCommand: (command: string, callback: <T>(...args: any[]) => T | Promise<T>) => {
      const c: Command = {
        command: command,
        callback: callback,
        ...newDisposable(() => {
          // Unregister command when disposed
          registry.commands.delete(command);
        })
      };
      // Error if command is about to be overridden
      if (registry.commands.has(command)) {
        throw new Error(`Could not register "${command}" because it already exists!`);
      }
      // Register command
      registry.commands.set(command, c);
      log.debug('Extensions', `[${extManifest.displayName || extManifest.name}] Registered Command "${command}"`);
      return c;
    },
    registerShortcut: (command, shortcut) => {
      let shortcuts: string[] = [];
      if (typeof shortcut === 'string') {
        shortcuts = [shortcut];
      } else {
        shortcuts = shortcut;
      }

      const commandName = `${extId}:${command}`;

      state.shortcuts[commandName] = shortcuts;
      state.socketServer.broadcast(BackOut.SHORTCUT_REGISTER_COMMAND, commandName, shortcuts);

      return {
        toDispose: [],
        isDisposed: false,
        /** Callback to use when disposed */
        onDispose: () => {
          delete state.shortcuts[commandName];
          state.socketServer.broadcast(BackOut.SHORTCUT_UNREGISTER, shortcuts);
        }
      };
    }
  };

  const extGames: typeof flashpoint.games = {
    // Platforms
    findPlatformByName: async (name) => fpDatabase.findPlatform(name),
    findPlatforms: async () => fpDatabase.findAllPlatforms(),
    // Playlists
    findPlaylist: (playlistId) => findPlaylist(state, playlistId),
    findPlaylistByName: (playlistName) => findPlaylistByName(state, playlistName),
    findPlaylists: (showExtreme) => filterPlaylists(state.playlists, showExtreme),
    updatePlaylist: async (playlist) => {
      const oldPlaylist = state.playlists.find(p => p.id === playlist.id);
      if (oldPlaylist) {
        await updatePlaylist(state, oldPlaylist, playlist);
        return playlist;
      } else {
        throw 'Playlist does not exist';
      }
    },
    removePlaylist: (playlistId) => deletePlaylist(state, playlistId),
    addPlaylistGame: (playlistId, gameId) => addPlaylistGame(state, playlistId, gameId),

    // Playlist Game
    findPlaylistGame: (playlistId, gameId) => getPlaylistGame(state, playlistId, gameId),
    removePlaylistGame: (playlistId, gameId) => deletePlaylistGame(state, playlistId, gameId),
    updatePlaylistGame: (playlistId, playlistGame) => savePlaylistGame(state, playlistId, playlistGame),

    // Games
    countGames: async () => fpDatabase.countGames(),
    findGame: async (id) => fpDatabase.findGame(id),
    // searchGames: await fpDatabase.searchGames,
    findGamesWithTag: async (name) => fpDatabase.searchGamesWithTag(name),
    updateGame: async (game) => fpDatabase.saveGame(game),
    updateGames: async (games) => fpDatabase.saveGames(games),
    removeGameAndAddApps: async (gameId: string) => fpDatabase.deleteGame(gameId),
    isGameExtreme: (game: Game) => {
      const extremeTags = state.preferences.tagFilters.filter(t => t.extreme).reduce<string[]>((prev, cur) => prev.concat(cur.tags), []);
      return game.tags.findIndex(t => extremeTags.includes(t.trim())) !== -1;
    },

    // Events
    get onWillLaunchGame() {
      return apiEmitters.games.onWillLaunchGame.extEvent(extManifest.displayName || extManifest.name);
    },
    get onWillLaunchAddApp() {
      return apiEmitters.games.onWillLaunchAddApp.extEvent(extManifest.displayName || extManifest.name);
    },
    get onWillLaunchCurationGame() {
      return apiEmitters.games.onWillLaunchCurationGame.extEvent(extManifest.displayName || extManifest.name);
    },
    get onWillLaunchCurationAddApp() {
      return apiEmitters.games.onWillLaunchCurationAddApp.extEvent(extManifest.displayName || extManifest.name);
    },
    get onDidLaunchGame() {
      return apiEmitters.games.onDidLaunchGame.extEvent(extManifest.displayName || extManifest.name);
    },
    get onDidLaunchAddApp() {
      return apiEmitters.games.onDidLaunchAddApp.extEvent(extManifest.displayName || extManifest.name);
    },
    get onDidLaunchCurationGame() {
      return apiEmitters.games.onDidLaunchCurationGame.extEvent(extManifest.displayName || extManifest.name);
    },
    get onDidLaunchCurationAddApp() {
      return apiEmitters.games.onDidLaunchCurationAddApp.extEvent(extManifest.displayName || extManifest.name);
    },
    get onDidUpdateGame() {
      return apiEmitters.games.onDidUpdateGame.extEvent(extManifest.displayName || extManifest.name);
    },
    get onDidRemoveGame() {
      return apiEmitters.games.onDidRemoveGame.extEvent(extManifest.displayName || extManifest.name);
    },
    get onDidUpdatePlaylist() {
      return apiEmitters.games.onDidUpdatePlaylist.extEvent(extManifest.displayName || extManifest.name);
    },
    get onDidUpdatePlaylistGame() {
      return apiEmitters.games.onDidUpdatePlaylistGame.extEvent(extManifest.displayName || extManifest.name);
    },
    get onDidRemovePlaylistGame() {
      return apiEmitters.games.onDidRemovePlaylistGame.extEvent(extManifest.displayName || extManifest.name);
    },
    get onDidInstallGameData() {
      return apiEmitters.games.onDidInstallGameData.extEvent(extManifest.displayName || extManifest.name);
    },
    get onDidUninstallGameData() {
      return apiEmitters.games.onDidUninstallGameData.extEvent(extManifest.displayName || extManifest.name);
    },
    get onWillImportGame() {
      return apiEmitters.games.onWillImportCuration.extEvent(extManifest.displayName || extManifest.name);
    },
    get onWillUninstallGameData() {
      return apiEmitters.games.onWillUninstallGameData.extEvent(extManifest.displayName || extManifest.name);
    }
  };

  const extGameData: typeof flashpoint.gameData = {
    findOne: async (id) => fpDatabase.findGameDataById(id),
    findGameData: async (gameId) => fpDatabase.findGameData(gameId),
    save: async (gameData) => fpDatabase.saveGameData(gameData),
    // importGameData: (gameId: string, filePath: string) => GameDataManager.importGameData(gameId, filePath, path.join(state.config.flashpointPath, state.preferences.dataPacksFolderPath)),
    downloadGameData: async (gameDataId: number) => {
      const onProgress = (percent: number) => {
        // Sent to PLACEHOLDER download dialog on client
        state.socketServer.broadcast(BackOut.SET_PLACEHOLDER_DOWNLOAD_PERCENT, percent);
      };
      state.socketServer.broadcast(BackOut.OPEN_PLACEHOLDER_DOWNLOAD_DIALOG);
      await downloadGameData(gameDataId, path.join(state.config.flashpointPath, state.preferences.dataPacksFolderPath), state.preferences.gameDataSources, state.downloadController.signal(), onProgress)
      .catch((error) => {
        state.socketServer.broadcast(BackOut.OPEN_ALERT, error);
      })
      .finally(() => {
        // Close PLACEHOLDER download dialog on client, cosmetic delay to look nice
        setTimeout(() => {
          state.socketServer.broadcast(BackOut.CLOSE_PLACEHOLDER_DOWNLOAD_DIALOG);
        }, 250);
      });
    },
    get onDidImportGameData() {
      return apiEmitters.gameData.onDidImportGameData.extEvent(extManifest.displayName || extManifest.name);
    }
  };

  const extTags: typeof flashpoint.tags = {
    // Tags
    getTagById: async (id) => fpDatabase.findTagById(id),
    findTag: async (name) => fpDatabase.findTag(name),
    findTags: async () => fpDatabase.findAllTags(),
    createTag: async (name, category) => fpDatabase.createTag(name, category),
    saveTag: async (tag) => fpDatabase.saveTag(tag),
    deleteTag: async (tagId: number, skipWarn?: boolean) => {
      const tag = await fpDatabase.findTagById(tagId);
      if (tag) {
        return fpDatabase.deleteTag(tag.name);
      } else {
        throw 'Tag does not exist';
      }
    },

    // Tag Categories
    getTagCategoryById: async (id) => fpDatabase.findTagCategoryById(id),
    findTagCategories: async () => fpDatabase.findAllTagCategories(),
    createTagCategory: async (name, color) => fpDatabase.createTagCategory({
      id: -1,
      name,
      color
    }),
    saveTagCategory: async (tc) => fpDatabase.saveTagCategory(tc),
    // deleteTagCategory: (tagCategoryId: number) => {
    //   const openDialogFunc = getOpenMessageBoxFunc(state);
    //   if (!openDialogFunc) { throw new Error('No suitable client for dialog func.'); }
    //   return TagManager.deleteTagCategory(tagCategoryId, openDialogFunc, state);
    // },

    // Tag Suggestions
    // TODO FIX: Update event to allow custom filters from ext
    findTagSuggestions: async (text: string) => [],

    // Misc
    mergeTags: async (mergeData: flashpoint.MergeTagData) => {
      return fpDatabase.mergeTags(mergeData.toMerge, mergeData.mergeInto);
    },
  };

  const extStatus: typeof flashpoint.status = {
    setStatus: <T extends keyof StatusState>(key: T, val: StatusState[T]) => setStatus(state, key, val),
    getStatus: <T extends keyof StatusState>(key: T): StatusState[T] => state.status[key],
    newTask: (task: flashpoint.PreTask) => {
      const newTask: Task = {
        ...task,
        id: uuid()
      };
      state.socketServer.broadcast(BackOut.CREATE_TASK, newTask);
      return newTask;
    },
    setTask: (task: Partial<Task>) => {
      state.socketServer.broadcast(BackOut.UPDATE_TASK, task);
    },
  };

  const extServices: typeof flashpoint.services = {
    runService: (name: string, info: flashpoint.ProcessInfo, opts?: flashpoint.ProcessOpts, basePath?: string) => {
      const id = `${extManifest.name}.${name}`;
      return runService(state, id, name, basePath || extPath || state.config.flashpointPath, opts || {}, {
        ...info,
        kill: true
      });
    },
    createProcess: (name: string, info: flashpoint.ProcessInfo, opts?: flashpoint.ProcessOpts, basePath?: string) => {
      const id = `${extManifest.name}.${name}`;
      const cwd = path.join(basePath || extPath || state.config.flashpointPath, info.path);
      const proc = new DisposableChildProcess(id, name, cwd, opts || {}, { aliases: [], name: '', ...info, kill: true });
      proc.onDispose = () => proc.kill();
      return proc;
    },
    removeService: (process: any) => removeService(state, process.id),
    getServices: () => Array.from(state.services.values()),

    get onServiceNew() {
      return apiEmitters.services.onServiceNew.extEvent(extManifest.displayName || extManifest.name);
    },
    get onServiceRemove() {
      return apiEmitters.services.onServiceRemove.extEvent(extManifest.displayName || extManifest.name);
    },
    get onServiceChange() {
      return apiEmitters.services.onServiceChange.extEvent(extManifest.displayName || extManifest.name);
    }
  };

  const extDialogs: typeof flashpoint.dialogs = {
    showMessageBox: async (options: flashpoint.DialogStateTemplate) => {
      const openDialogFunc = getOpenMessageBoxFunc(state);
      if (!openDialogFunc) { throw new Error('No suitable client for dialog func.'); }
      const dialogId = await openDialogFunc(options);
      return (await awaitDialog(state, dialogId)).buttonIdx;
    },
    showMessageBoxWithHandle: async (options: flashpoint.DialogStateTemplate) => {
      const openDialogFunc = getOpenMessageBoxFunc(state);
      if (!openDialogFunc) { throw new Error('No suitable client for dialog func.'); }
      return openDialogFunc(options);
    },
    awaitDialog: (dialogId: string) => awaitDialog(state, dialogId),
    cancelDialog: async (dialogId: string) => {
      state.socketServer.broadcast(BackOut.CANCEL_DIALOG, dialogId);
    },
    showSaveDialog: (options: flashpoint.ShowSaveDialogOptions) => {
      const openDialogFunc = getOpenSaveDialogFunc(state.socketServer);
      if (!openDialogFunc) { throw new Error('No suitable client for dialog func.'); }
      return openDialogFunc(options);
    },
    showOpenDialog: (options: flashpoint.ShowOpenDialogOptions) => {
      const openDialogFunc = getOpenOpenDialogFunc(state.socketServer);
      if (!openDialogFunc) { throw new Error('No suitable client for dialog func.'); }
      return openDialogFunc(options);
    },
    updateDialogField: (dialogId, name, value) => {
      state.socketServer.broadcast(BackOut.UPDATE_DIALOG_FIELD_VALUE, dialogId, name, value);
    }
  };

  const extCurations: typeof flashpoint.curations = {
    loadCurationArchive: async (filePath: string, taskId?: string) => {
      if (taskId) {
        state.socketServer.broadcast(BackOut.UPDATE_TASK, {
          id: taskId,
          status: `Loading ${filePath}`
        });
      }
      const curState = await loadCurationArchive(filePath, null)
      .catch((error) => {
        log.error('Curate', `Failed to load curation archive! ${error.toString()}`);
        state.socketServer.broadcast(BackOut.OPEN_ALERT, formatString(state.languageContainer['dialog'].failedToLoadCuration, error.toString()) as string);
      });
      if (taskId) {
        state.socketServer.broadcast(BackOut.UPDATE_TASK, {
          id: taskId,
          status: '',
          finished: true
        });
      }
      if (curState) {
        return curState;
      } else {
        throw new Error('Failed to import');
      }
    },
    duplicateCuration: (folder: string) => {
      return duplicateCuration(folder, state);
    },
    getCurations: () => {
      return [...state.loadedCurations];
    },
    async getCurationTemplates(): Promise<CurationTemplate[]> {
      const contribs = await state.extensionsService.getContributions('curationTemplates');
      return contribs.reduce<CurationTemplate[]>((prev, cur) => prev.concat(cur.value), []);
    },
    getCuration: (folder: string) => {
      const curation = state.loadedCurations.find(c => c.folder === folder);
      return curation ? { ...curation } : undefined;
    },
    get onDidCurationListChange() {
      return apiEmitters.curations.onDidCurationListChange.extEvent(extManifest.displayName || extManifest.name);
    },
    get onDidCurationChange() {
      return apiEmitters.curations.onDidCurationChange.extEvent(extManifest.displayName || extManifest.name);
    },
    get onWillGenCurationWarnings() {
      return apiEmitters.curations.onWillGenCurationWarnings.extEvent(extManifest.displayName || extManifest.name);
    },
    setCurationGameMeta: (folder: string, meta: flashpoint.CurationMeta) => {
      const curation = state.loadedCurations.find(c => c.folder === folder);
      if (curation) {
        if (curation.locked) {
          return false;
        }
        curation.game = {
          ...curation.game,
          ...meta
        };
        saveCuration(path.join(state.config.flashpointPath, CURATIONS_FOLDER_WORKING, curation.folder), curation)
        .then(() => state.apiEmitters.curations.onDidCurationChange.fire(curation));
        state.socketServer.broadcast(BackOut.CURATE_LIST_CHANGE, [curation]);
        return true;
      } else {
        throw 'Not a valid curation folder';
      }
    },
    setCurationAddAppMeta: (folder: string, key: string, meta: flashpoint.AddAppCurationMeta) => {
      const curation = state.loadedCurations.find(c => c.folder === folder);
      if (curation) {
        if (curation.locked) {
          return false;
        }
        const addAppIdx = curation.addApps.findIndex(a => a.key === key);
        if (addAppIdx !== -1) {
          const existingAddApp = curation.addApps[addAppIdx];
          curation.addApps[addAppIdx] = {
            key: existingAddApp.key,
            ...meta
          };
          state.socketServer.broadcast(BackOut.CURATE_LIST_CHANGE, [curation]);
          return true;
        } else {
          throw 'Not a valid add app.';
        }
      } else {
        throw 'Not a valid curation folder';
      }
    },
    selectCurations: (folders: string[]) => {
      state.socketServer.broadcast(BackOut.CURATE_SELECT_CURATIONS, folders);
    },
    updateCurationContentTree: async (folder: string) => {
      const curationIdx = state.loadedCurations.findIndex(c => c.folder === folder);
      if (curationIdx !== -1) {
        const curation = state.loadedCurations[curationIdx];
        return genContentTree(getContentFolderByKey(curation.folder, state.config.flashpointPath))
        .then((contentTree) => {
          const idx = state.loadedCurations.findIndex(c => c.folder === folder);
          if (idx > -1) {
            state.loadedCurations[idx].contents = contentTree;
            state.socketServer.broadcast(BackOut.CURATE_CONTENTS_CHANGE, folder, contentTree);
            return contentTree;
          }
        });
      } else {
        throw 'No curation with that folder.';
      }
    },
    newCuration: async (meta?: CurationMeta) => {
      const folder = uuid();
      const curPath = path.join(state.config.flashpointPath, CURATIONS_FOLDER_WORKING, folder);
      await fs.promises.mkdir(curPath, { recursive: true });
      const contentFolder = path.join(curPath, 'content');
      await fs.promises.mkdir(contentFolder, { recursive: true });

      const data: flashpoint.LoadedCuration = {
        folder,
        uuid: uuid(),
        group: '',
        game: meta || {},
        addApps: [],
        fpfssInfo: null,
        thumbnail: await loadCurationIndexImage(path.join(curPath, 'logo.png')),
        screenshot: await loadCurationIndexImage(path.join(curPath, 'ss.png'))
      };
      const curation: flashpoint.CurationState = {
        ...data,
        alreadyImported: false,
        warnings: await genCurationWarnings(data, state.config.flashpointPath, state.suggestions, state.languageContainer.curate, state.apiEmitters.curations.onWillGenCurationWarnings),
        contents: await genContentTree(getContentFolderByKey(folder, state.config.flashpointPath))
      };
      await saveCuration(curPath, curation);
      state.loadedCurations.push(curation);
      state.socketServer.broadcast(BackOut.CURATE_LIST_CHANGE, [curation]);
      return curation;
    },
    deleteCuration: (folder: string) => {
      return deleteCuration(state, folder);
    },
    getCurationPath: (folder: string) => {
      return path.join(state.config.flashpointPath, CURATIONS_FOLDER_WORKING, folder);
    },
    makeCurationFromGame: (gameId: string, skipDataPack?: boolean) => {
      return makeCurationFromGame(state, gameId, skipDataPack);
    },
    refreshCurationContent: (folder: string) => {
      return refreshCurationContent(state, folder);
    }
  };

  const extMiddlewares: typeof flashpoint.middleware = {
    registerMiddleware: (middleware: flashpoint.IGameMiddleware) => {
      // Minor hack to set ext id
      const registeredMiddleware: RegisteredMiddleware = middleware as RegisteredMiddleware;
      registeredMiddleware.extId = extId;
      state.registry.middlewares.set(middleware.id, registeredMiddleware);
    },
    writeGameFile: async (filePath: string, rs: stream.Readable) => {
      // Append to overrides directory
      const fullPath = path.join(state.config.flashpointPath, state.config.middlewareOverridePath, filePath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      // Write file
      const ws = fs.createWriteStream(fullPath);
      log.debug('Launcher', 'Writing override file to ' + fullPath);
      return new Promise((resolve, reject) => {
        ws.on('error', reject);
        ws.on('finish', resolve);
        rs.pipe(ws);
      });
    },
    writeGameFileByUrl: async (url: string, rs: stream.Readable) => {
      // Convert url to file path
      let filePath = url;
      if (url.startsWith('https://')) {
        filePath = url.substring('https://'.length);
      }
      if (url.startsWith('http://')) {
        filePath = url.substring('http://'.length);
      }
      const fullPath = path.join(state.config.flashpointPath, state.config.middlewareOverridePath, filePath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      log.debug('Launcher', 'Writing override file to ' + fullPath);
      // Write file
      const ws = fs.createWriteStream(fullPath);
      return new Promise((resolve, reject) => {
        ws.on('error', reject);
        ws.on('finish', resolve);
        rs.pipe(ws);
      });
    },
    copyGameFilesByUrl: async (url: string, source: string) => {
      // Convert url to file path
      let filePath = url;
      if (url.startsWith('https://')) {
        filePath = url.substring('https://'.length);
      }
      if (url.startsWith('http://')) {
        filePath = url.substring('http://'.length);
      }
      const fullPath = path.join(state.config.flashpointPath, state.config.middlewareOverridePath, filePath);
      await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
      log.debug('Launcher', `Copying override from "${source}" to "${fullPath}"`);
      return fsExtra.copy(source, fullPath);
    },
    extractGameFile: (path: string) => {
      return '' as any; // UNIMPLEMENTED
    },
    extractGameFileByUrl: (url: string) => {
      return '' as any; // UNIMPLEMENTED
    },
  };

  const extFpfss: typeof flashpoint.fpfss = {
    getAccessToken: async (): Promise<string> => {
      if (!state.socketServer.lastClient) {
        throw new Error('No connected client to handle FPFSS action.');
      }
      try {
        const user = await state.socketServer.request(state.socketServer.lastClient, BackOut.FPFSS_ACTION, extId);
        if (user && user.accessToken) {
          return user.accessToken;
        } else {
          throw new Error('Failed to get access token or user cancelled.');
        }
      } catch (error) {
        const client = state.socketServer.lastClient;
        const openDialog = state.socketServer.showMessageBoxBack(state, client);
        await openDialog({
          largeMessage: true,
          message: (error instanceof Error) ? error.message : String(error),
          buttons: [state.languageContainer.misc.ok]
        });
        throw error;
      }
    },
  };

  // Create API Module to give to caller
  return <typeof flashpoint>{
    // General information
    version: version,
    dataVersion: state.customVersion,
    extensionPath: extPath,
    config: state.config,
    getPreferences: getPreferences,
    overwritePreferenceData: extOverwritePreferenceData,
    unloadExtension: unloadExtension,
    reloadExtension: reloadExtension,
    getExtensionFileURL: getExtensionFileURL,
    unzipFile: unzipFile,
    getExtConfigValue: getExtConfigValue,
    setExtConfigValue: setExtConfigValue,
    onExtConfigChange: state.apiEmitters.ext.onExtConfigChange.extEvent(extManifest.displayName || extManifest.name),
    focusWindow: focusWindow,

    // Namespaces
    log: extLog,
    commands: extCommands,
    curations: extCurations,
    games: extGames,
    gameData: extGameData,
    tags: extTags,
    status: extStatus,
    services: extServices,
    dialogs: extDialogs,
    middleware: extMiddlewares,
    fpfss: extFpfss,

    // Events
    onDidInit: apiEmitters.onDidInit.extEvent(extManifest.displayName || extManifest.name),
    onDidConnect: apiEmitters.onDidConnect.extEvent(extManifest.displayName || extManifest.name),

    // Classes
    DisposableChildProcess: DisposableChildProcess,
    ManagedChildProcess: ManagedChildProcess,

    // Enums
    ProcessState: ProcessState,
    BrowsePageLayout: BrowsePageLayout,
    LogLevel: LogLevel,
    ScreenshotPreviewMode: ScreenshotPreviewMode,

    // Disposable funcs
    dispose: dispose,
    clearDisposable: clearDisposable,
    registerDisposable: registerDisposable,
    newDisposable: newDisposable

    // Note - Types are defined in the declaration file, not here
  };
}
