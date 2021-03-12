import { StoreConstructor } from '../core/StoreConstructor';
import { action, computed, observable } from 'mobx';
import { statusFetching } from '../../constants';
import {
  ACTION_TYPE,
  EXCHANGE_MODE,
  IOperation,
  NETWORK_TYPE,
  STATUS,
  TConfig,
  TFullConfig,
  TOKEN,
} from '../interfaces';
import * as operationService from 'services';
import { getDepositAmount } from 'services';

import * as contract from '../../blockchain-bridge';
import { sleep, uuid } from '../../utils';
import { sendHrc20Token } from './hrc20';
import { sendErc721Token } from './erc721';
import { getAddress } from '@harmony-js/crypto';
import { send1ETHToken } from './1ETH';
import { send1ONEToken } from './1ONE';
import { getContractMethods } from './helpers';
import { initNetworks } from '../../blockchain-bridge';
import { getExNetworkMethods } from '../../blockchain-bridge';
import { defaultEthClient } from './defaultConfig';

export enum EXCHANGE_STEPS {
  GET_TOKEN_ADDRESS = 'GET_TOKEN_ADDRESS',
  BASE = 'BASE',
  APPROVE = 'APPROVE',
  CONFIRMATION = 'CONFIRMATION',
  SENDING = 'SENDING',
  RESULT = 'RESULT',
}

export interface IStepConfig {
  id: EXCHANGE_STEPS;
  buttons: Array<{
    title: string;
    onClick: () => void;
    validate?: boolean;
    transparent?: boolean;
  }>;
  title?: string;
}

export interface ITransaction {
  oneAddress: string;
  ethAddress: string;
  amount: string | string[];
  approveAmount: string;
  erc20Address?: string;
  hrc20Address?: string;
}

export class Exchange extends StoreConstructor {
  @observable error = '';
  @observable txHash = '';
  @observable actionStatus: statusFetching = 'init';
  @observable stepNumber = 0;
  @observable isFeeLoading = false;
  @observable isDepositAmountLoading = false;
  @observable depositAmount = 0;

  @observable network: NETWORK_TYPE = NETWORK_TYPE.ETHEREUM;

  defaultTransaction: ITransaction = {
    oneAddress: '',
    ethAddress: '',
    amount: '0',
    approveAmount: '0',
    erc20Address: '',
    hrc20Address: '',
  };

  @observable transaction = this.defaultTransaction;
  @observable mode: EXCHANGE_MODE = EXCHANGE_MODE.ETH_TO_ONE;
  @observable token: TOKEN;

  constructor(stores) {
    super(stores);

    setInterval(async () => {
      if (this.operation) {
        const operation = await operationService.getOperation(
          this.operation.id,
        );

        if (this.operation && this.operation.id === operation.id) {
          this.operation = operation;
          this.setStatus();
        }
      }
    }, 3000);
  }

  @computed
  get step() {
    return this.stepsConfig[this.stepNumber];
  }

  @observable ethNetworkFee = 0;

  @computed
  get networkFee() {
    return this.mode === EXCHANGE_MODE.ETH_TO_ONE
      ? this.ethNetworkFee
      : this.depositAmount + 0.0134438;
  }

  stepsConfig: Array<IStepConfig> = [
    {
      id: EXCHANGE_STEPS.BASE,
      buttons: [
        {
          title: 'Continue',
          onClick: async () => {
            // this.transaction.oneAddress = this.stores.user.address;

            if (this.token === TOKEN.HRC20) {
              this.transaction.hrc20Address = getAddress(
                this.stores.user.hrc20Address,
              ).checksum;
            } else {
              this.transaction.erc20Address = this.stores.userMetamask.erc20Address;
            }

            switch (this.mode) {
              case EXCHANGE_MODE.ETH_TO_ONE:
                this.transaction.ethAddress = this.stores.userMetamask.ethAddress;
                break;
              case EXCHANGE_MODE.ONE_TO_ETH:
                this.transaction.oneAddress = this.stores.user.address;
                break;
            }

            this.transaction.approveAmount = '0';

            if (this.token === TOKEN.ERC721) {
              this.stepNumber = this.stepNumber + 2;
            } else {
              await this.getAllowance();

              if (
                Number(this.allowance) / 1e18 >=
                Number(this.transaction.amount)
              ) {
                this.stepNumber = this.stepNumber + 2;
              } else {
                this.transaction.approveAmount = String(
                  this.transaction.amount,
                );
                this.stepNumber = this.stepNumber + 1;
              }
            }

            const exNetwork = getExNetworkMethods();

            switch (this.mode) {
              case EXCHANGE_MODE.ETH_TO_ONE:
                this.isFeeLoading = true;
                this.ethNetworkFee = await exNetwork.getNetworkFee();
                this.isFeeLoading = false;
                break;
              case EXCHANGE_MODE.ONE_TO_ETH:
                this.isFeeLoading = true;
                this.depositAmount = await getDepositAmount();
                this.isFeeLoading = false;
                break;
            }
          },
          validate: true,
        },
      ],
    },
    {
      id: EXCHANGE_STEPS.APPROVE,
      buttons: [
        {
          title: 'Back',
          onClick: () => (this.stepNumber = this.stepNumber - 1),
          transparent: true,
        },
        {
          title: 'Continue',
          onClick: () => {
            this.stepNumber = this.stepNumber + 1;
          },
          validate: true,
        },
      ],
    },
    {
      id: EXCHANGE_STEPS.CONFIRMATION,
      buttons: [
        {
          title: 'Back',
          onClick: () => {
            if (Number(this.transaction.approveAmount) > 0) {
              this.stepNumber = this.stepNumber - 1;
            } else {
              this.stepNumber = 0;
            }
          },
          transparent: true,
        },
        {
          title: 'Confirm',
          onClick: () => {
            this.stepNumber = this.stepNumber + 1;
            this.sendOperation();
          },
        },
      ],
    },
    {
      id: EXCHANGE_STEPS.SENDING,
      buttons: [],
    },
    {
      id: EXCHANGE_STEPS.RESULT,
      buttons: [
        {
          title: 'Close',
          transparent: true,
          onClick: () => {
            this.clear();
            this.stepNumber = 0;
          },
        },
      ],
    },
  ];

  @action.bound
  setAddressByMode() {
    if (this.mode === EXCHANGE_MODE.ETH_TO_ONE) {
      // this.transaction.oneAddress = this.stores.user.address;
      this.transaction.oneAddress = '';
      this.transaction.ethAddress = this.stores.userMetamask.ethAddress;
    }

    if (this.mode === EXCHANGE_MODE.ONE_TO_ETH) {
      // this.transaction.ethAddress = this.stores.userMetamask.ethAddress;
      this.transaction.ethAddress = '';
      this.transaction.oneAddress = this.stores.user.address;
    }
  }

  @action.bound
  setMode(mode: EXCHANGE_MODE) {
    if (
      this.operation &&
      [STATUS.IN_PROGRESS, STATUS.WAITING].includes(this.operation.status)
    ) {
      return;
    }

    this.clear();
    this.mode = mode;
    this.setAddressByMode();
  }

  @action.bound
  setNetwork(network: NETWORK_TYPE) {
    if (
      this.operation &&
      [STATUS.IN_PROGRESS, STATUS.WAITING].includes(this.operation.status)
    ) {
      return;
    }

    this.clear();
    this.network = network;
    // this.setAddressByMode();
  }

  @action.bound
  setToken(token: TOKEN) {
    // this.clear();
    this.token = token;
    // this.setAddressByMode();
  }

  @observable operation: IOperation;

  @action.bound
  setStatus() {
    switch (this.operation.status) {
      case STATUS.ERROR:
        this.actionStatus = 'error';
        this.stepNumber = this.stepsConfig.length - 1;
        break;

      case STATUS.SUCCESS:
        this.actionStatus = 'success';
        this.stepNumber = this.stepsConfig.length - 1;
        break;

      case STATUS.WAITING:
      case STATUS.IN_PROGRESS:
        this.stepNumber = 3;
        this.actionStatus = 'fetching';
        break;
    }
  }

  @action.bound
  async setOperationId(operationId: string) {
    this.operation = await operationService.getOperation(operationId);

    this.mode = this.operation.type;
    this.token = this.operation.token;
    this.network = this.operation.network;
    this.transaction.amount = Array.isArray(this.operation.amount)
      ? this.operation.amount
      : String(this.operation.amount);
    this.transaction.ethAddress = this.operation.ethAddress;
    this.transaction.oneAddress = this.operation.oneAddress;
    this.transaction.erc20Address = this.operation.erc20Address;

    this.setStatus();
  }

  @action.bound
  async createOperation() {
    this.operation = await operationService.createOperation({
      ...this.transaction,
      type: this.mode,
      token: this.token,
      network: this.network,
      id: uuid(),
    });

    return this.operation.id;
  }

  getActionByType = (type: ACTION_TYPE) =>
    this.operation.actions.find(a => a.type === type);

  @action.bound
  async sendOperation(id: string = '') {
    try {
      this.actionStatus = 'fetching';

      let operationId = id;

      if (!operationId) {
        operationId = await this.createOperation();

        this.stores.routing.push(
          this.token + '/operations/' + this.operation.id,
        );
      }

      // if (!operationId) {
      //   const bridgeSDK = new BridgeSDK({ logLevel: 2 }); // 2 - full logs, 1 - only success & errors, 0 - logs off
      //
      //   await bridgeSDK.init(configs.testnet);
      //
      //   await bridgeSDK.setUseOneWallet(true);
      //   await bridgeSDK.setUseMetamask(true);
      //
      //   await bridgeSDK.sendToken(
      //     {
      //       ...this.transaction,
      //       amount: Number(this.transaction.amount),
      //       type: this.mode,
      //       token: this.token,
      //     },
      //     id => this.setOperationId(id),
      //   );
      //
      //   return;
      // }

      await this.setOperationId(operationId);

      if (
        this.operation.status === STATUS.SUCCESS ||
        this.operation.status === STATUS.ERROR
      ) {
        return;
      }

      const confirmCallback = async (
        transactionHash,
        actionType: ACTION_TYPE,
      ) => {
        this.operation = await operationService.confirmAction({
          operationId,
          transactionHash,
          actionType,
        });
      };

      if (!this.stores.user.address || !this.stores.userMetamask.ethAddress) {
        await sleep(3000);
      }

      if (this.mode === EXCHANGE_MODE.ETH_TO_ONE) {
        if (this.operation.ethAddress !== this.stores.userMetamask.ethAddress) {
          return;
        }
      }

      if (this.mode === EXCHANGE_MODE.ONE_TO_ETH) {
        if (this.operation.oneAddress !== this.stores.user.address) {
          return;
        }
      }

      if (this.mode === EXCHANGE_MODE.ONE_TO_ETH) {
        const hmyMethods = this.stores.user.isMetamask
          ? contract.hmyMethodsDeposit.hmyMethodsWeb3
          : contract.hmyMethodsDeposit.hmyMethods;

        let depositOne = this.getActionByType(ACTION_TYPE.depositOne);

        if (depositOne && depositOne.status === STATUS.WAITING) {
          await hmyMethods.deposit(depositOne.depositAmount, hash =>
            confirmCallback(hash, depositOne.type),
          );
        }

        while (
          [STATUS.WAITING, STATUS.IN_PROGRESS].includes(depositOne.status)
        ) {
          depositOne = this.getActionByType(ACTION_TYPE.depositOne);

          await sleep(500);
        }

        if (depositOne.status !== STATUS.SUCCESS) {
          return;
        }
      }

      let ethMethods, hmyMethods;
      const exNetwork = getExNetworkMethods();

      switch (this.token) {
        case TOKEN.BUSD:
          ethMethods = exNetwork.ethMethodsBUSD;
          hmyMethods = this.stores.user.isMetamask
            ? contract.hmyMethodsBUSD.hmyMethodsWeb3
            : contract.hmyMethodsBUSD.hmyMethods;
          break;

        case TOKEN.LINK:
          ethMethods = exNetwork.ethMethodsLINK;
          hmyMethods = this.stores.user.isMetamask
            ? contract.hmyMethodsLINK.hmyMethodsWeb3
            : contract.hmyMethodsLINK.hmyMethods;
          break;

        case TOKEN.ERC20:
          ethMethods = exNetwork.ethMethodsERC20;
          hmyMethods = this.stores.user.isMetamask
            ? contract.hmyMethodsERC20.hmyMethodsWeb3
            : contract.hmyMethodsERC20.hmyMethods;
          break;

        case TOKEN.ONE:
          await send1ONEToken({
            transaction: this.transaction,
            mode: this.mode,
            stores: this.stores,
            getActionByType: this.getActionByType,
            confirmCallback: confirmCallback,
          });
          return;

        case TOKEN.ETH:
          await send1ETHToken({
            transaction: this.transaction,
            mode: this.mode,
            stores: this.stores,
            getActionByType: this.getActionByType,
            confirmCallback: confirmCallback,
          });
          return;

        case TOKEN.ERC721:
          await sendErc721Token({
            transaction: this.transaction,
            mode: this.mode,
            stores: this.stores,
            getActionByType: this.getActionByType,
            confirmCallback: confirmCallback,
          });
          return;

        case TOKEN.HRC20:
          await sendHrc20Token({
            transaction: this.transaction,
            mode: this.mode,
            stores: this.stores,
            getActionByType: this.getActionByType,
            confirmCallback: confirmCallback,
          });
          return;
      }

      if (this.token === TOKEN.ERC20) {
        let getHRC20Action = this.getActionByType(ACTION_TYPE.getHRC20Address);

        while (
          getHRC20Action &&
          [STATUS.IN_PROGRESS, STATUS.WAITING].includes(getHRC20Action.status)
        ) {
          await sleep(3000);
          getHRC20Action = this.getActionByType(ACTION_TYPE.getHRC20Address);
        }

        if (!this.stores.user.hrc20Address) {
          await this.stores.userMetamask.setToken(
            this.transaction.erc20Address,
          );
        }

        if (this.mode === EXCHANGE_MODE.ETH_TO_ONE) {
          let approveEthManger = this.getActionByType(
            ACTION_TYPE.approveEthManger,
          );

          if (approveEthManger && approveEthManger.status === STATUS.WAITING) {
            const { approveAmount, erc20Address } = this.transaction;

            ethMethods.approveEthManger(
              erc20Address,
              approveAmount,
              this.stores.userMetamask.erc20TokenDetails.decimals,
              hash => confirmCallback(hash, approveEthManger.type),
            );
          }

          while (
            [STATUS.WAITING, STATUS.IN_PROGRESS].includes(
              approveEthManger.status,
            )
          ) {
            approveEthManger = this.getActionByType(
              ACTION_TYPE.approveEthManger,
            );

            await sleep(500);
          }

          if (approveEthManger.status !== STATUS.SUCCESS) {
            return;
          }

          const lockToken = this.getActionByType(ACTION_TYPE.lockToken);

          if (lockToken.status === STATUS.WAITING) {
            await ethMethods.lockToken(
              this.transaction.erc20Address,
              this.transaction.oneAddress,
              this.transaction.amount,
              this.stores.userMetamask.erc20TokenDetails.decimals,
              hash => confirmCallback(hash, lockToken.type),
            );
          }

          return;
        }

        if (this.mode === EXCHANGE_MODE.ONE_TO_ETH) {
          const hrc20Address = this.stores.user.hrc20Address;

          let approveHmyManger = this.getActionByType(
            ACTION_TYPE.approveHmyManger,
          );

          if (approveHmyManger && approveHmyManger.status === STATUS.WAITING) {
            await hmyMethods.approveHmyManger(
              hrc20Address,
              this.transaction.approveAmount,
              this.stores.userMetamask.erc20TokenDetails.decimals,
              hash => confirmCallback(hash, approveHmyManger.type),
            );
          }

          while (
            [STATUS.WAITING, STATUS.IN_PROGRESS].includes(
              approveHmyManger.status,
            )
          ) {
            approveHmyManger = this.getActionByType(
              ACTION_TYPE.approveHmyManger,
            );

            await sleep(500);
          }

          if (approveHmyManger.status !== STATUS.SUCCESS) {
            return;
          }

          const burnToken = this.getActionByType(ACTION_TYPE.burnToken);

          if (burnToken && burnToken.status === STATUS.WAITING) {
            await hmyMethods.burnToken(
              hrc20Address,
              this.transaction.ethAddress,
              this.transaction.amount,
              this.stores.userMetamask.erc20TokenDetails.decimals,
              hash => confirmCallback(hash, burnToken.type),
            );
          }

          return;
        }
      } else {
        if (this.mode === EXCHANGE_MODE.ETH_TO_ONE) {
          let approveEthManger = this.getActionByType(
            ACTION_TYPE.approveEthManger,
          );

          if (approveEthManger && approveEthManger.status === STATUS.WAITING) {
            ethMethods.approveEthManger(this.transaction.approveAmount, hash =>
              confirmCallback(hash, approveEthManger.type),
            );
          }

          while (
            [STATUS.WAITING, STATUS.IN_PROGRESS].includes(
              approveEthManger.status,
            )
          ) {
            approveEthManger = this.getActionByType(
              ACTION_TYPE.approveEthManger,
            );

            await sleep(500);
          }

          if (approveEthManger.status !== STATUS.SUCCESS) {
            return;
          }

          const lockToken = this.getActionByType(ACTION_TYPE.lockToken);

          if (lockToken && lockToken.status === STATUS.WAITING) {
            await ethMethods.lockToken(
              this.transaction.oneAddress,
              this.transaction.amount,
              hash => confirmCallback(hash, lockToken.type),
            );
          }

          return;
        }

        if (this.mode === EXCHANGE_MODE.ONE_TO_ETH) {
          let approveHmyManger = this.getActionByType(
            ACTION_TYPE.approveHmyManger,
          );

          if (approveHmyManger && approveHmyManger.status === STATUS.WAITING) {
            await hmyMethods.approveHmyManger(
              this.transaction.approveAmount,
              hash => confirmCallback(hash, approveHmyManger.type),
            );
          }

          while (
            [STATUS.WAITING, STATUS.IN_PROGRESS].includes(
              approveHmyManger.status,
            )
          ) {
            approveHmyManger = this.getActionByType(
              ACTION_TYPE.approveHmyManger,
            );

            await sleep(500);
          }

          if (approveHmyManger.status !== STATUS.SUCCESS) {
            return;
          }

          const burnToken = this.getActionByType(ACTION_TYPE.burnToken);

          if (burnToken && burnToken.status === STATUS.WAITING) {
            await hmyMethods.burnToken(
              this.transaction.ethAddress,
              this.transaction.amount,
              hash => confirmCallback(hash, burnToken.type),
            );
          }

          return;
        }
      }

      return;
    } catch (e) {
      if (e.status && e.response.body) {
        this.error = e.response.body.message;
      } else {
        this.error = e.message || e;
      }

      this.actionStatus = 'error';
      this.operation = null;
    }

    this.stepNumber = this.stepsConfig.length - 1;
  }

  @observable allowance = '0';
  @observable allowanceStatus: statusFetching = 'init';
  @observable allowanceError = '';

  @computed get needToApprove() {
    return Number(this.transaction.amount) > Number(this.allowance) / 1e18;
  }

  @action.bound
  clearAllowance = () => {
    this.allowance = '0';
    this.allowanceStatus = 'fetching';
    this.allowanceError = '';
  };

  @action.bound
  getAllowance = async () => {
    this.allowance = '0';
    this.transaction.approveAmount = '0';
    this.allowanceStatus = 'fetching';
    this.allowanceError = '';

    const { ethMethods, hmyMethods } = getContractMethods(
      this.token,
      this.stores.user.isMetamask,
    );

    debugger;
    try {
      if (this.mode === EXCHANGE_MODE.ONE_TO_ETH) {
        console.log(this.transaction.oneAddress, this.transaction.erc20Address);

        this.allowance = await hmyMethods.allowance(
          this.transaction.oneAddress,
          this.transaction.erc20Address,
        );
      }

      if (this.mode === EXCHANGE_MODE.ETH_TO_ONE) {
        console.log(this.transaction.ethAddress, this.transaction.erc20Address);

        this.allowance = await ethMethods.allowance(
          this.transaction.ethAddress,
          this.transaction.erc20Address,
        );
      }
    } catch (e) {
      this.allowanceError = e.message;
    }

    this.allowanceStatus = 'success';
  };

  clear() {
    this.transaction = this.defaultTransaction;
    this.operation = null;
    this.error = '';
    this.txHash = '';
    this.actionStatus = 'init';
    this.stepNumber = 0;
    this.stores.routing.push(`/${this.token}`);
  }

  @observable fullConfig: TFullConfig;

  @action.bound
  getConfig = async () => {
    this.fullConfig = await operationService.getConfig();
    initNetworks(this.fullConfig);
  };

  @computed
  get config(): TConfig {
    if (!this.fullConfig) {
      return defaultEthClient;
    }

    if (this.network === NETWORK_TYPE.ETHEREUM) {
      return this.fullConfig.ethClient;
    }

    if (this.network === NETWORK_TYPE.BINANCE) {
      return this.fullConfig.binanceClient;
    }

    return this.fullConfig.ethClient;
  }

  getExplorerByNetwork(network: NETWORK_TYPE) {
    if (!this.fullConfig) {
      return defaultEthClient.explorerURL;
    }

    switch (network) {
      case NETWORK_TYPE.BINANCE:
        return this.fullConfig.binanceClient.explorerURL;
      case NETWORK_TYPE.ETHEREUM:
        return this.fullConfig.ethClient.explorerURL;
    }
  }
}
