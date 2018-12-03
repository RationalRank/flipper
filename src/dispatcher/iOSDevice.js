/**
 * Copyright 2018-present Facebook.
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * @format
 */

import type {ChildProcess} from 'child_process';
import type {Store} from '../reducers/index.js';
import type Logger from '../fb-stubs/Logger.js';
import type {DeviceType} from '../devices/BaseDevice';

import {promisify} from 'util';
import path from 'path';
import child_process from 'child_process';
const execFile = child_process.execFile;
import IOSDevice from '../devices/IOSDevice';
import iosUtil from '../fb-stubs/iOSContainerUtility';
import isProduction from '../utils/isProduction.js';

type iOSSimulatorDevice = {|
  state: 'Booted' | 'Shutdown' | 'Shutting Down',
  availability?: string,
  isAvailable?: 'YES' | 'NO',
  name: string,
  udid: string,
|};

type IOSDeviceParams = {udid: string, type: DeviceType, name: string};

const portforwardingClient = isProduction()
  ? path.resolve(
      __dirname,
      'PortForwardingMacApp.app/Contents/MacOS/PortForwardingMacApp',
    )
  : 'PortForwardingMacApp.app/Contents/MacOS/PortForwardingMacApp';

function forwardPort(port: number, multiplexChannelPort: number) {
  return execFile(portforwardingClient, [
    `-portForward=${port}`,
    `-multiplexChannelPort=${multiplexChannelPort}`,
  ]);
}
// start port forwarding server for real device connections
const portForwarders: Array<ChildProcess> = [
  forwardPort(8089, 8079),
  forwardPort(8088, 8078),
];
window.addEventListener('beforeunload', () => {
  portForwarders.forEach(process => process.kill());
});

function queryDevices(store: Store): Promise<void> {
  const {connections} = store.getState();
  const currentDeviceIDs: Set<string> = new Set(
    connections.devices
      .filter(device => device instanceof IOSDevice)
      .map(device => device.serial),
  );
  return Promise.all([getActiveSimulators(), getActiveDevices()])
    .then(([a, b]) => a.concat(b))
    .then(activeDevices => {
      for (const {udid, type, name} of activeDevices) {
        if (currentDeviceIDs.has(udid)) {
          currentDeviceIDs.delete(udid);
        } else {
          store.dispatch({
            type: 'REGISTER_DEVICE',
            payload: new IOSDevice(udid, type, name),
          });
        }
      }

      if (currentDeviceIDs.size > 0) {
        store.dispatch({
          type: 'UNREGISTER_DEVICES',
          payload: currentDeviceIDs,
        });
      }
    });
}

function getActiveSimulators(): Promise<Array<IOSDeviceParams>> {
  return promisify(execFile)('xcrun', ['simctl', 'list', 'devices', '--json'], {
    encoding: 'utf8',
  })
    .then(({stdout}) => JSON.parse(stdout).devices)
    .then(simulatorDevices => {
      const simulators: Array<iOSSimulatorDevice> = Object.values(
        simulatorDevices,
        // $FlowFixMe
      ).reduce((acc, cv) => acc.concat(cv), []);

      return simulators
        .filter(
          simulator =>
            simulator.state === 'Booted' &&
            // For some users "availability" is set, for others it's "isAvailable"
            // It's not clear which key is set, so we are checking both.
            (simulator.availability === '(available)' ||
              simulator.isAvailable === 'YES'),
        )
        .map(simulator => {
          return {
            udid: simulator.udid,
            type: 'emulator',
            name: simulator.name,
          };
        });
    });
}

function getActiveDevices(): Promise<Array<IOSDeviceParams>> {
  return iosUtil.targets().catch(e => {
    console.warn(e);
    return [];
  });
}

export default (store: Store, logger: Logger) => {
  // monitoring iOS devices only available on MacOS.
  if (process.platform !== 'darwin') {
    return;
  }
  queryDevices(store)
    .then(() => {
      const simulatorUpdateInterval = setInterval(() => {
        queryDevices(store).catch(err => {
          console.error(err);
          clearInterval(simulatorUpdateInterval);
        });
      }, 3000);
    })
    .catch(console.error);
};
