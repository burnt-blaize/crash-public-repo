import {
  FinishedWorkerEvent,
  StartWorkerEvent,
  TxWorkerEvent,
} from '@/services/game/worker';
import { XionService, XionSigner } from '@/services/xion';
import { TypedEventEmitter } from '@/services/common';
import { mapFrom } from '@/utils';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { IGame, GameEvents, GameState } from './core';
import { SigningCosmWasmClient } from '@cosmjs/cosmwasm-stargate';

export class Game extends TypedEventEmitter<GameEvents> implements IGame {
  private wallets!: DirectSecp256k1HdWallet[];
  private signers!: XionSigner[];
  private readonly duration: number;
  private readonly interval: number;

  private workers!: Worker[];
  private readonly numberOfSigners: number;
  private readonly mnemonics: string[];

  private isInitialized = false;
  private isRunning = false;
  private isFinished = false;
  private txCount = 0;
  private endTime = 0;
  private signerIndex = 0;
  walletClient: SigningCosmWasmClient;
  accountAddress: string | undefined;

  constructor(
    numberOfSigners: number,
    duration: number,
    interval: number,
    mnemonics: string[] = [],
    walletClient: SigningCosmWasmClient,
    accountAddress: string | undefined,
  ) {
    super();
    this.numberOfSigners = numberOfSigners;
    this.duration = duration;
    this.mnemonics = mnemonics;
    this.walletClient = walletClient;
    this.interval = interval;
    this.accountAddress = accountAddress;
  }

  getState(): GameState {
    return {
      duration: this.duration,
      wallets: this.wallets,
      signers: this.signers,
      isRunning: this.isRunning,
      isFinished: this.isFinished,
      txCount: this.txCount,
      endTime: this.endTime,
      walletClient: this.walletClient,
      accountAddress: this.accountAddress,
    };
  }

  async init() {
    console.log('Initializing game...');

    this.workers = mapFrom(this.numberOfSigners, () => {
      return new Worker(new URL('./worker.ts', import.meta.url));
    });

    console.log('Creating wallets...');
    this.wallets = await Promise.all(
      mapFrom(this.numberOfSigners, async (index) =>
        XionService.createWallet(this.mnemonics[index]),
      ),
    );

    console.log('Requesting funds...');
    await Promise.all(
      this.wallets.map(async (wallet) => {
        console.log('mnemonic', wallet.mnemonic);

        const [firstAccount] = await wallet.getAccounts();

        return XionService.requestFunds(firstAccount.address);
      }),
    );
    console.log('Creating signers...');
    this.signers = await Promise.all(
      this.wallets.map(async (wallet) =>
        XionService.createXionSigner(
          wallet,
          this.walletClient,
          this.accountAddress,
        ),
      ),
    );

    console.log('Game initialized!');
    this.isInitialized = true;
  }

  start() {
    if (!this.isInitialized) {
      throw new Error('Game is not initialized!');
    }

    if (this.isRunning) {
      throw new Error('Game is already running!');
    }

    this.isRunning = true;
    this.isFinished = false;
    this.endTime = Date.now() + this.duration;

    console.log('Starting game...');
    this.workers.forEach((worker, index) => {
      const startEvent: StartWorkerEvent = {
        event: 'start',
        mnemonic: this.mnemonics[index] || this.wallets[index].mnemonic,
        endTime: this.endTime,
        interval: this.interval,
      };

      worker.postMessage(startEvent);

      worker.onmessage = (
        event: MessageEvent<TxWorkerEvent | FinishedWorkerEvent>,
      ) => {
        if (event.data.event === 'finished') {
          this.isFinished = true;
          this.terminate();
          this.emit('finished', this.getState());
        }

        if (event.data.event === 'tx') {
          this.txCount++;
          this.emit('tx', event.data.hash, this.txCount, this.getState());
        }
      };

      worker.onerror = (err) => {
        this.emit('error', err);
      };
    });

    this.emit('started', this.getState());
  }

  restart() {
    this.txCount = 0;
    this.isFinished = false;
    this.workers = mapFrom(this.numberOfSigners, () => {
      return new Worker(new URL('./worker.ts', import.meta.url));
    });
  }

  terminate() {
    this.isRunning = false;
    this.workers.forEach((worker) => {
      worker.terminate();
    });
  }
}
