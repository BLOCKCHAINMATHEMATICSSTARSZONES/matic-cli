import inquirer from 'inquirer'
import Listr from 'listr'
import path from 'path'
import chalk from 'chalk'
import execa from 'execa'
import fs from 'fs-extra'
import nunjucks from 'nunjucks'
import { toBuffer, privateToPublic, bufferToHex } from 'ethereumjs-util'

import { Heimdall } from '../heimdall'
import { Genesis } from '../genesis'
import { Ganache } from '../ganache'
import { printDependencyInstructions, getDefaultBranch } from '../helper'
import { getNewPrivateKey, getKeystoreFile, processTemplateFiles } from '../../lib/utils'
import { loadConfig, saveConfig } from '../config'
import fileReplacer from '../../lib/file-replacer'

export class Multinode {
  constructor(config, options = {}) {
    this.config = config
  }

  get testnetDir() {
    return path.join(this.config.targetDirectory, 'devnet')
  }

  get signerDumpPath() {
    return path.join(this.testnetDir, 'signer-dump.json')
  }

  get signerDumpData() {
    return require(this.signerDumpPath)
  }

  get totalNodes() {
    return this.config.numOfValidators + this.config.numOfNonValidators
  }

  nodeDir(index) {
    return path.join(this.testnetDir, `node${index}`)
  }

  heimdallDir(index) {
    return path.join(this.nodeDir(index), 'heimdalld')
  }

  heimdallConfigFilePath(index) {
    return path.join(this.heimdallDir(index), 'config', 'config.toml')
  }

  heimdallGenesisFilePath(index) {
    return path.join(this.heimdallDir(index), 'config', 'genesis.json')
  }

  heimdallHeimdallConfigFilePath(index) {
    return path.join(this.heimdallDir(index), 'config', 'heimdall-config.toml')
  }

  borDir(index) {
    return path.join(this.nodeDir(index), 'bor')
  }

  borDataDir(index) {
    return path.join(this.borDir(index), 'data')
  }

  borKeystoreDir(index) {
    return path.join(this.borDir(index), 'keystore')
  }

  borGenesisFilePath(index) {
    return path.join(this.borDir(index), 'genesis.json')
  }

  borPasswordFilePath(index) {
    return path.join(this.borDir(index), 'password.txt')
  }

  borPrivateKeyFilePath(index) {
    return path.join(this.borDir(index), 'privatekey.txt')
  }

  borAddressFilePath(index) {
    return path.join(this.borDir(index), 'address.txt')
  }

  borNodeKeyPath(index) {
    return path.join(this.borDir(index), 'nodekey')
  }

  borEnodeFilePath(index) {
    return path.join(this.borDir(index), 'enode.txt')
  }

  borStaticNodesPath(index) {
    return path.join(this.borDir(index), 'static-nodes.json')
  }

  async getEnodeTask() {
    return {
      title: 'Setup enode',
      task: async () => {
        const staticNodes = []

        // create new enode 
        for (let i = 0; i < this.totalNodes; i++) {
          const enodeObj = await getNewPrivateKey()
          const pubKey = bufferToHex(privateToPublic(toBuffer(enodeObj.privateKey))).replace("0x", "")

          // draft enode
          const enode = `enode://${pubKey}@${this.config.devnetBorHosts[i]}:30303`

          // add into static nodes
          staticNodes.push(enode)

          // store data into nodekey and enode
          const p = [
            // create nodekey file
            fs.writeFile(
              this.borNodeKeyPath(i),
              `${enodeObj.privateKey.replace("0x", "")}\n`,
              { mode: 0o600 }
            ),
            // create enode file
            fs.writeFile(
              this.borEnodeFilePath(i),
              `${enode}\n`,
              { mode: 0o600 }
            ),
          ]
          await Promise.all(p)
        }

        // create static-nodes 
        const data = JSON.stringify(staticNodes, null, 2)
        for (let i = 0; i < this.totalNodes; i++) {
          await fs.writeFile(
            this.borStaticNodesPath(i),
            data,
            { mode: 0o600 }
          )
        }
      }
    }
  }

  async getDockerTasks() {
    const enodeTask = await this.getEnodeTask()
    return [
      enodeTask,
      {
        title: 'Process Heimdall configs',
        task: async () => {
          // set heimdall 
          for (let i = 0; i < this.totalNodes; i++) {
            fileReplacer(this.heimdallHeimdallConfigFilePath(i)).
              replace(/eth_rpc_url[ ]*=[ ]*".*"/gi, `eth_rpc_url = "${this.config.ethURL}"`).
              replace(/bor_rpc_url[ ]*=[ ]*".*"/gi, `bor_rpc_url = "http://bor${i}:8545"`).
              replace(/amqp_url[ ]*=[ ]*".*"/gi, `amqp_url = "amqp://guest:guest@rabbit${i}:5672/"`).
              save()
          }
        }
      },
      {
        title: 'Process templates',
        task: async () => {
          const templateDir = path.resolve(
            new URL(import.meta.url).pathname,
            '../templates'
          );

          // copy docker related templates
          await fs.copy(path.join(templateDir, 'docker'), this.config.targetDirectory)

          // process template files
          await processTemplateFiles(this.config.targetDirectory, { obj: this })
        }
      }
    ]
  }

  async getRemoteTasks() {
    const enodeTask = await this.getEnodeTask()
    return [
      enodeTask,
      {
        title: 'Process Heimdall configs',
        task: async () => {
          // set heimdall 
          for (let i = 0; i < this.totalNodes; i++) {
            fileReplacer(this.heimdallHeimdallConfigFilePath(i)).
              replace(/eth_rpc_url[ ]*=[ ]*".*"/gi, `eth_rpc_url = "${this.config.ethURL}"`).
              replace(/bor_rpc_url[ ]*=[ ]*".*"/gi, `bor_rpc_url = "http://localhost:8545"`).
              replace(/amqp_url[ ]*=[ ]*".*"/gi, `amqp_url = "amqp://guest:guest@localhost:5672/"`).
              save()
          }
        }
      },
      {
        title: 'Process templates',
        task: async () => {
          const templateDir = path.resolve(
            new URL(import.meta.url).pathname,
            '../templates'
          );

          // copy remote related templates
          await fs.copy(path.join(templateDir, 'remote'), this.config.targetDirectory)

          // promises
          const p = []
          const signerDumpData = this.signerDumpData

          // process njk files
          fs.readdirSync(this.config.targetDirectory).forEach(file => {
            if (file.indexOf(".njk") !== -1) {
              const fp = path.join(this.config.targetDirectory, file)

              // process all njk files and copy to each node directory
              for (let i = 0; i < this.totalNodes; i++) {
                fs.writeFileSync(
                  path.join(this.nodeDir(i), file.replace(".njk", "")),
                  nunjucks.render(fp, { obj: this, node: i, signerData: signerDumpData[i] }),
                )
              }

              // remove njk file
              p.push(execa('rm', ['-rf', fp], {
                cwd: this.config.targetDirectory
              }))
            }
          });

          // fulfill all promises
          await Promise.all(p)
        }
      },
    ]
  }

  async getCreateTestnetTask(heimdall) {
    return [
      heimdall.cloneRepositoryTask(),
      heimdall.buildTask(),
      {
        title: 'Create testnet files for Heimdall',
        task: async () => {
          const args = [
            'create-testnet',
            '--v', this.config.numOfValidators,
            '--n', this.config.numOfNonValidators,
            '--chain-id', this.config.heimdallChainId,
            '--node-host-prefix', 'heimdall',
            '--output-dir', 'devnet'
          ]

          // create testnet
          await execa(heimdall.heimdalldCmd, args, {
            cwd: this.config.targetDirectory
          })


          // get root contracts
          const rootContracts = this.config.contractAddresses.root

          // set heimdall peers with devnet heimdall hosts
          for (let i = 0; i < this.totalNodes; i++) {
            fileReplacer(this.heimdallConfigFilePath(i)).
              replace(/heimdall([^:]+):/gi, (d, index) => {
                return `${this.config.devnetHeimdallHosts[index]}:`
              }).
              replace(/moniker.+=.+/gi, `moniker = "heimdall${i}"`).
              save()

            fileReplacer(this.heimdallGenesisFilePath(i)).
              replace(/"bor_chain_id"[ ]*:[ ]*".*"/gi, `"bor_chain_id": "${this.config.borChainId}"`).
              save()

            fileReplacer(this.heimdallGenesisFilePath(i)).
            replace(/"matic_token_address":[ ]*".*"/gi, `"matic_token_address": "${rootContracts.tokens.TestToken}"`).
            replace(/"staking_manager_address":[ ]*".*"/gi, `"staking_manager_address": "${rootContracts.StakeManagerProxy}"`).
            replace(/"root_chain_address":[ ]*".*"/gi, `"root_chain_address": "${rootContracts.RootChainProxy}"`).
            replace(/"staking_info_address":[ ]*".*"/gi, `"staking_info_address": "${rootContracts.StakingInfo}"`).
            replace(/"state_sender_address":[ ]*".*"/gi, `"state_sender_address": "${rootContracts.StateSender}"`).
            save()
          }
        }
      }
    ]
  }

  async getTasks() {
    const ganache = new Ganache(this.config, { repositoryBranch: this.config.defaultBranch })
    const heimdall = new Heimdall(this.config, { repositoryBranch: this.config.defaultBranch })
    const genesis = new Genesis(this.config, { repositoryBranch: 'master' })

    // create testnet tasks
    const createTestnetTasks = await this.getCreateTestnetTask(heimdall)

    return new Listr(
      [
        {
          title: ganache.taskTitle,
          task: () => {
            return ganache.getTasks()
          }
        },
        ...createTestnetTasks,
        {
          title: 'Process ganache templates',
          task: async () => {
            const templateDir = path.resolve(
              new URL(import.meta.url).pathname,
              '../templates'
            );
            console.log("venkyyy template dir", templateDir)
            // copy all templates to target directory
            await fs.copy(templateDir, this.config.targetDirectory)

            // process all njk templates
            await processTemplateFiles(this.config.targetDirectory, { obj: this })
          }
        },
        {
          title: genesis.taskTitle,
          task: () => {
            // set validator addresses
            const genesisAddresses = []
            const signerDumpData = this.signerDumpData
            for (let i = 0; i < this.config.numOfValidators; i++) {
              const d = signerDumpData[i]
              genesisAddresses.push(d.address)
            }

            // set genesis addresses
            this.config.genesisAddresses = genesisAddresses

            // get genesis tasks
            return genesis.getTasks()
          }
        },
        {
          title: 'Setup Bor keystore and genesis files',
          task: async () => {
            const signerDumpData = this.signerDumpData

            for (let i = 0; i < this.totalNodes; i++) {
              // create directories
              await execa('mkdir', ['-p', this.borDataDir(i), this.borKeystoreDir(i)])
              const password = `password${i}`

              // create keystore files
              const keystoreFileObj = getKeystoreFile(signerDumpData[i].priv_key, password)
              const p = [
                // save password file
                fs.writeFile(
                  this.borPasswordFilePath(i),
                  `${password}\n`
                ),
                // save private key file
                fs.writeFile(
                  this.borPrivateKeyFilePath(i),
                  `${signerDumpData[i].priv_key}\n`
                ),
                // save address file
                fs.writeFile(
                  this.borAddressFilePath(i),
                  `${signerDumpData[i].address}\n`
                ),
                // save keystore file
                fs.writeFile(
                  path.join(this.borKeystoreDir(i), keystoreFileObj.keystoreFilename),
                  JSON.stringify(keystoreFileObj.keystore, null, 2)
                ),
                // copy genesis file to each node bor directory
                execa('cp', [genesis.borGenesisFilePath, this.borGenesisFilePath(i)])
              ]
              await Promise.all(p)
            }
          }
        },
        {
          title: 'Docker',
          task: async () => {
            const tasks = await this.getDockerTasks()
            return new Listr(tasks)
          },
          enabled: () => {
            return this.config.devnetType === 'docker'
          }
        },
        {
          title: 'Remote',
          task: async () => {
            const tasks = await this.getRemoteTasks()
            return new Listr(tasks)
          },
          enabled: () => {
            return this.config.devnetType === 'remote'
          }
        }
      ]
    )
  }
}

async function setupMultinode(config) {  
  const multinode = new Multinode(config)

  const tasks = await multinode.getTasks()  
  await tasks.run()
  console.log('%s Multinode is ready', chalk.green.bold('DONE'))
}

export async function getHosts(n) {
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'devnetHosts',
      message: 'Please enter comma separated hosts/IPs',
      validate: (input) => {
        const hosts = input.split(',').map(a => {
          return a.trim().toLowerCase()
        })

        if (hosts.length === 0 || hosts.length !== n) {
          return `Enter valid ${n} hosts/IPs (comma separated)`
        }

        return true
      }
    }
  ])

  return answers.devnetHosts.split(',').map(a => {
    return a.trim().toLowerCase()
  })
}

export default async function () {  
  await printDependencyInstructions()

  // configuration
  const config = await loadConfig()
  await config.loadChainIds()
  await config.loadAccount()

  // load branch
  let answers = await getDefaultBranch(config)
  config.set(answers)

  const questions = []
  if (!('numOfValidators' in config)) {
    questions.push({
      type: 'number',
      name: 'numOfValidators',
      message: 'Please enter number of validator nodes',
      default: 2
    })
  }

  if (!('numOfNonValidators' in config)) {
    questions.push({
      type: 'number',
      name: 'numOfNonValidators',
      message: 'Please enter number of non-validator nodes',
      default: 2
    })
  }

  if (!('ethURL' in config)) {
    questions.push({
      type: 'input',
      name: 'ethURL',
      message: 'Please enter ETH url',
      default: 'http://host.docker.internal:9545'
    })
  }

  if (!('devnetType' in config)) {
    questions.push({
      type: 'list',
      name: 'devnetType',
      message: 'Please select devnet type',
      choices: [
        'docker',
        'remote'
      ]
    })
  }

  answers = await inquirer.prompt(questions)
  config.set(answers)

  // set devent hosts
  let devnetBorHosts = []
  let devnetHeimdallHosts = []
  let totalValidators = config.numOfValidators + config.numOfNonValidators
  if (config.devnetType === 'docker') {
    [...Array(totalValidators).keys()].forEach((i) => {
      devnetBorHosts.push(`172.20.1.${i + 100}`)
      devnetHeimdallHosts.push(`heimdall${i}`)
    })
  } else {
    const hosts = await getHosts(totalValidators)
    devnetBorHosts = hosts
    devnetHeimdallHosts = hosts
  }
  config.set({ devnetBorHosts, devnetHeimdallHosts })

  // start setup
  await setupMultinode(config)


  // save config
  await saveConfig(config, config.configDir )
}
