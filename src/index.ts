import type { AccessoryConfig, API, CharacteristicValue, Logging, Service, AccessoryPlugin, MatterAccessory } from 'homebridge';
import { v5 as uuidv5 } from 'uuid';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

type Parameter = {
  ParameterId: number;
  Value: string;
};

export default (api: API) => {
  api.registerAccessory('Optiflame', OptiflameAccessoryPlugin);
};

class OptiflameAccessoryPlugin implements AccessoryPlugin {

  private readonly services: Array<Service>;
  private readonly log: Logging;
  private readonly api: API;
  private readonly url = 'https://app-mobileapiext-gdhv.azurewebsites.net/api/Fires/';
  private readonly gdid: string;
  private readonly pin: string;
  private readonly deviceId: string;
  private readonly displayName: string;
  private readonly matterAccessoryUuid: string;
  private state: CharacteristicValue = false;
  private params: Parameter[] = [];
  private readonly headers = {
    'Content-type': 'application/json; charset=UTF-8',
    'app_name': 'FlameConnect',
    'app_device_os': 'iOS',
    'app_version': '2.20.2',
    'api_version': '1.0',
    'device_model': 'iPad8,6',
  };

  /**
   * REQUIRED - This is the entry point to your plugin
   */
  constructor(log: Logging, config: AccessoryConfig, api: API) {
    this.log = log;
    this.api = api;
    this.gdid = config.gdid;
    this.pin = config.pin;
    this.deviceId = uuidv5(config.gdid, '6ba7b812-9dad-11d1-80b4-00c04fd430c8');
    this.displayName = config.name;
    this.matterAccessoryUuid = api.matter?.uuid.generate(`optiflame-${this.gdid}`) ?? api.hap.uuid.generate(`optiflame-${this.gdid}`);

    log.debug('Optiflame Accessory Plugin Loaded');

    // your accessory must have an AccessoryInformation service
    const informationService = new api.hap.Service.AccessoryInformation()
      .setCharacteristic(api.hap.Characteristic.Manufacturer, 'github.com/dubocr')
      .setCharacteristic(api.hap.Characteristic.Model, 'Optiflame');

    // create a new "Switch" service
    const switchService = new api.hap.Service.Switch(config.name);

    // link methods used when getting or setting the state of the service 
    switchService.getCharacteristic(api.hap.Characteristic.On)
      .onGet(this.getOnHandler.bind(this))   // bind to getOnHandler method below
      .onSet(this.setOnHandler.bind(this));  // bind to setOnHandler method below

    this.services = [
      informationService,
      switchService,
    ];
    void this.init();
    void this.registerMatterAccessory();
  }

  async init() {
    await this.login();
    await this.update();
    await this.updateMatterState();
  }

  async registerMatterAccessory() {
    if (!this.api.isMatterEnabled() || !this.api.matter) {
      return;
    }

    const accessory: MatterAccessory = {
      UUID: this.matterAccessoryUuid,
      displayName: this.displayName,
      deviceType: this.api.matter.deviceTypes.OnOffSwitch,
      serialNumber: this.deviceId,
      manufacturer: 'github.com/dubocr',
      model: 'Optiflame',
      firmwareRevision: '1.0.0',
      context: {
        deviceId: this.deviceId,
        gdid: this.gdid,
      },
      clusters: {
        onOff: {
          onOff: Boolean(this.state),
        },
      },
      handlers: {
        onOff: {
          on: async () => {
            await this.setOnHandler(true);
          },
          off: async () => {
            await this.setOnHandler(false);
          },
        },
      },
    };

    await this.api.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    await this.updateMatterState();
  }

  async login() {
    const data = {
      DeviceId: this.deviceId,
      Identifier: this.gdid,
      AccessCode: this.pin,
      IsValidationEnabled: true,
    };
    const response = await fetch(this.url + 'VerifyGuestMode', {
      method: 'POST',
      body: JSON.stringify(data),
      headers: this.headers,
    });

    const result = await response.json();

    this.log.debug(result);
  }

  async update() {
    const response = await fetch(this.url + 'GetFireOverview?DeviceId=' + this.deviceId + '&FireId=' + this.gdid, {
      method: 'GET',
      headers: this.headers,
    });

    const result = await response.json();

    if (result.WifiFireOverview) {
      this.log.debug(result.WifiFireOverview.Parameters);
      this.params = result.WifiFireOverview.Parameters.filter((p: Parameter) => [321, 323].includes(p.ParameterId));
      const param = result.WifiFireOverview.Parameters.find((p: Parameter) => p.ParameterId === 321);
      const bytes = Buffer.from(param.Value, 'base64');
      this.state = bytes[3] ? true : false;
    } else {
      this.log.error(result);
    }
  }

  async updateMatterState() {
    if (!this.api.isMatterEnabled() || !this.api.matter) {
      return;
    }

    await this.api.matter.updateAccessoryState(
      this.matterAccessoryUuid,
      this.api.matter.clusterNames.OnOff,
      { onOff: Boolean(this.state) },
    );
  }

  /**
   * REQUIRED - This must return an array of the services you want to expose.
   * This method must be named "getServices".
   */
  getServices() {
    return this.services;
  }

  async getOnHandler() {
    return this.state;
  }

  async setOnHandler(value: CharacteristicValue) {
    const params = this.params.map((p: Parameter) => {
      if (p.ParameterId === 321) {
        const bytes = Buffer.from(p.Value, 'base64');
        bytes[3] = value ? 0x01 : 0x00;
        return {
          ParameterId: 321,
          Value: bytes.toString('base64'),
        };
      } else if (p.ParameterId === 323) {
        const bytes = Buffer.from(p.Value, 'base64');
        bytes[3] = 0x00;
        return {
          ParameterId: 323,
          Value: bytes.toString('base64'),
        };
      } else {
        return p;
      }
    }).sort((a, b) => a.ParameterId - b.ParameterId);
    this.log.debug(JSON.stringify(params));
    const data = {
      WriteWiFiParametersRequest: {
        FireId: this.gdid,
        Parameters: params,
      },
      DeviceId: this.deviceId,
    };
    const response = await fetch(this.url + 'WriteWifiParameters', {
      method: 'POST',
      body: JSON.stringify(data),
      headers: this.headers,
    });

    const result = await response.json();
    this.log.debug(result);
    if (!result.IsException) {
      this.state = value;
      await this.updateMatterState();
    }
  }
}
