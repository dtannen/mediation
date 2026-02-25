interface IpcMainLike {
  handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => void;
  removeHandler: (channel: string) => void;
}

export interface IpcRegistry {
  handle: (
    ipcMain: IpcMainLike,
    channel: string,
    handler: (event: unknown, payload: any) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ) => void;
}

export function createIpcRegistry(): IpcRegistry {
  return {
    handle(ipcMain, channel, handler) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (event, payload) => handler(event, payload));
    },
  };
}
