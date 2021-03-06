var express = require('express');
var app = express();

const debug = require('debug')('utseus-api')

const cors = require('cors');
const config = require('./config.js');
const mock = require('./mock.js');
const http = require('./http.js');
const dataset = require('./dataset.js');
const ethereum = require('./ethereum.js');
const Promise = require('promise');

const register = require('./controllers/register.js');
const mentoring = require('./controllers/mentoring.js');
const contract = require('./controllers/contract.js');

// region constant

const API_V1_PREFIX = '/api/v1';

const ORGANISATION = "Organisation";
const COST = 10;
const BLOCK_COUNT_FULL_LOAD = 12;
const BLOCK_COUNT_HACKATHON = 0;

const isHackathon = true;

// endregion

// region initiate Web3

var Web3 = require('web3');
var web3 = new Web3(new Web3.providers.HttpProvider('http://localhost:8545')); 
console.info('w3', web3.eth.accounts);

// endregion

app.use(cors());

String.prototype.hashCode = function() {
    var hash = 0;
    if (this.length == 0) {
        return hash;
    }
    for (var i = 0; i < this.length; i++) {
        char = this.charCodeAt(i);
        hash = ((hash<<5)-hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
}

app.get(API_V1_PREFIX + '/users', function (req, res) {
	console.log("w3", "request users");
	console.log("w3", getUsers());
	var json = getUsers();
	res.status(http.SUCCESS).json(json);
});

app.get(API_V1_PREFIX + '/queue', function (req, res) {
	res.send(getWaitingQueue());
})

app.get(API_V1_PREFIX + '/skills', function (req, res) {
	res.send(dataset.skills);
})

app.post(API_V1_PREFIX + '/help/:mentee/:skill/:time', function (req, res) {
	// TODO validate there is such profile
	const profileName = req.params.mentee;
	const skill = req.params.skill;
	const time = req.params.time;
    if (!(profileName in profiles)) {
        res.status(http.BAD_REQUEST).send('User is not valid');
    } else {
		console.log("w3", "Process help request");
		askForHelp(profileName, ORGANISATION, skill, time, COST)
            .then(function(txHash) {
				console.log("w3", "Initiate consensus");
                console.log("w3", "Hash: " + txHash);
                var blockCount = isHackathon ? BLOCK_COUNT_HACKATHON : BLOCK_COUNT_FULL_LOAD; // considered as an optimal for start 
				var timeout = 15 * 60;
				res.status(http.SUCCESS).send(prepareResponse(true, txHash));
				// TODO track history
                return startConsensus(web3, txHash, blockCount, timeout);
            })
            .catch(function(err) {
				console.log("w3", err);
				console.log("w3", "Error");
				// TODO process error here 
				res.status(http.BAD_REQUEST).send(prepareResponse(false, err));
			});
		console.log("w3", "Process help request [end]");
    }
})

app.post(API_V1_PREFIX + '/mentoring/:mentor/:mentee/:skill/:time', function (req, res) {
	const mentor = req.params.mentor;
	const mentee = req.params.mentee;
	const skill = req.params.skill;
	const time = req.params.time;
	certifyFunc(mentor, mentee, skill, time).then(function({status, message}) {
		res.status(status).send(message);
	});
	// TODO wait for receipt
})

app.get(API_V1_PREFIX + '/dashboard', function (req, res) {
	console.log("w3", "request dashboard");
	console.log("w3", "History: " + getHistory());
	var json = JSON.parse(getHistory());
	res.status(http.SUCCESS).json(json);
});

app.post(API_V1_PREFIX + '/register/:member/:skill', function (req, res) {
	const member = req.params.member;
	const skill = req.params.skill;
	registerMemberWithSkill(member, skill).then(function({status, message}){
		res.status(status).send(message);
	});
})

app.get(API_V1_PREFIX + '/validate/:txhash', function (req, res) {
	const txHash = req.params.txhash;
	checkReceipt(txHash)
		.then(function(message) {
			res.status(http.SUCCESS).send(message);
		})
		.catch(function(message) {
			res.status(http.BAD_REQUEST).send(message);
		});
})

function checkReceipt(txHash) {
	return new Promise(function(validate, reject) {
		const receipt = web3.eth.getTransactionReceipt(txHash);
		if (receipt === null) {
			return reject(prepareResponse(false, "No receipt for this txHash"));
		} else {
			const json = JSON.parse(JSON.stringify(receipt));
			const status = json.status == 1;
			return validate(prepareResponse(status, JSON.stringify(receipt)));
		}
	})
}

function registerMemberWithSkill(member, skill) {
	return new Promise(function(fulfill) {
		createCertificate(member, skill, ORGANISATION);
		fulfill({
			status: http.SUCCESS,
			message: 'user was successfully registered'
		}); 
	});
}

app.listen(config.port, () => {
	debug('App started at port %d', config.port);
})

function certifyFunc(mentor, mentee, skill, time) {
	return new Promise(function(fulfill) {
		if (!(mentor in profiles) || !(mentee in profiles)) {
			fulfill({
				status: http.BAD_REQUEST,
				message: 'Either mentor or mentee params is not valid'
			});
		} else {
			var mentorAccount = getAccountByName(mentor);
			var menteeAccount = getAccountByName(mentee);
			console.log("w3", "certifyFunc");
			console.log("w3", skill);
			certify(mentorAccount, menteeAccount, skill, time, COST);
			fulfill({
				status: http.SUCCESS,
				message: 'User was certified'
			});
			trackHistory(mentor, mentee, skill, time);
			markedRequestAsProcessedInWaitingQueue(mentee, ORGANISATION, skill, time);
			// TODO process negative scenario - no certification on blockchain
		}
	});
}

// endregion

// region runtime storage

var profiles = {
	'Dmitry' : '0x9c12379f8b6b9eb04f94537fe885f24993867aec',
	'Ricky' : '0xc52b6f924e4a696ae4cfb8c32b10f9e517723682',
	'Abhishek' : '0x1a3e5fede2ce731168af057a4357eeed3d64b210'
}

// endregion

process.stdout.write("starting web3..");

// region deploy the contract

let fs = require("fs");
let source = fs.readFileSync("SkillsMarket.js");
console.info('w3', source);
let contracts = JSON.parse(source)["contracts"];
console.info('w3', contracts);

var skillsMarketAbi = web3.eth.contract(JSON.parse(contracts['SkillsMarket.sol:SkillsMarket'].abi));
var skillsMarketBin = "0x" + contracts['SkillsMarket.sol:SkillsMarket'].bin;

console.info('w3', skillsMarketAbi);
console.info('w3', "=== ==== ===");
console.info('w3', skillsMarketBin);

// endregion

// region init the contract

var deployTransitionObject = {from: web3.eth.accounts[0], data: skillsMarketBin, gas: 2000000};
let skillsMarketContract = skillsMarketAbi.new(deployTransitionObject);

const receipt = web3.eth.getTransactionReceipt(skillsMarketContract.transactionHash);

console.info('w3', receipt);
console.info('w3', receipt.contractAddress);

const SkillsMarket = skillsMarketAbi.at(receipt.contractAddress);

// endregion

// region create an certificate

function createCertificate(profileName, skill, organization) {
	// TODO obtain data 
	// registerMemberSkills(address member, uint hashKey, bytes32 skill, uint spendHours, uint demandHours)
	var account = getAccountByName(profileName);
	var hashKey = (String(skill) + String(organization)).hashCode(); // TODO generate hashKey based on org and skill name
	var skillInBytes = web3.fromAscii(skill); // TODO convert skill string into bytes32
	var spendHours = 100; // optional
	var demandHours = 100; // optional

	console.log("w3", "Account: " + account);

	SkillsMarket.registerMemberSkills.sendTransaction(
		account,
		hashKey,
		skillInBytes, 
		spendHours, 
		demandHours,
		{from: account, gas: 300000}
	);
	
	// console.log("w3", "RegisterMemberSkills: ");
	
	// TODO wait till it would be executed on blockchain
	// TODO get a status and return back to the client
	const skillsLength = SkillsMarket.getSkillForMember(account);
	console.log("w3", "Amount of skills: " + skillsLength);
}

// endregion

// region ask for help

function prepareResponse(success, payload) {
	var item = { "success" : success, "payload" : String(payload)};
	return JSON.stringify(item);
}
 
function askForHelp(profileName, organisation, skill, time, cost) {
	return new Promise(function(resolve, reject) {
		console.log("w3", "start request");
		var callback = function(err, txHash) {
			console.log("w3", "receive tx callback");
			if (err) {
				console.log("w3", "reject");
				return reject(err);
			} else {
				console.log("w3", "resolve");
				return resolve(txHash);
			}
		}

        var account = getAccountByName(profileName); 
        var hashKey = (String(skill) + String(organisation)).hashCode();
		SkillsMarket.askForHelp.sendTransaction(
			hashKey,
			account,
			web3.fromAscii(skill),
			time,
			cost,
			{from: account, gas: 300000, value: cost},
			callback
		);

		console.log("w3", "end request");
	});
}

function startConsensus(currentNode, txHash, blockCount, timeout) {
    return new Promise(function(resolve, reject) {
        console.log("w3", "start consensus");
		addTransaction(txHash, false);
		var callback = function(err, recipe) {
            // TODO process data on the node 
            if (err) {
                console.log("w3", "Error due achieving consensus");
                return reject(err);
            } else {
                console.log("w3", recipe);
                updateTransaction(txHash, true);
                // TODO track history
                return resolve(txHash, true);
            }
        }
        ethereum.awaitBlockConsensus(currentNode, txHash, blockCount, timeout, callback);
    });
}

var skillRequestEvent = SkillsMarket.SkillRequest();
skillRequestEvent.watch(function(error, result) {
	if (error) {
		console.log("error: " + error);
	} else {
		console.log("result: " + result);
	}
});

// endregion

// region certify

function certify(mentorAccount, menteeAccount, skill, time) {
	console.log("w3", "[start] certify");
	var hashKey = (String(skill) + String(ORGANISATION)).hashCode();
	console.log("w3", "HashKey: " + hashKey);
	console.log("w3", "Mentor: " + mentorAccount + "\n");
	console.log("w3", "Mentee: " + menteeAccount + "\n");
	console.log("w3", "hashKey: " + hashKey + "\n");
	console.log("w3", "Time: " + time + "\n");
	const status = SkillsMarket.certify.sendTransaction(
		mentorAccount, 
		menteeAccount, 
		hashKey, 
		time, 
		time * COST,
		{from: mentorAccount, gas: 3000000});
		// .catch(error => console.log("Error: " + error));
	
	console.log("w3", status);
	console.log("w3", "[end] certify");
}

var mentorCertificationEvent = SkillsMarket.MentorCertification();
mentorCertificationEvent.watch(function(error, result) {
	if (error) {
		console.log("w3", "Mentor certify error: " + error);
	} else {
		console.log("w3", "Mentor certify result: " + result);
		console.log("w3", "Mentor certify result: " 
			+ result.mentor 
			+ " " 
			+ result.mentee);
	}
});

// endregion

// region Debug

var debugEventListener = SkillsMarket.Debug();
debugEventListener.watch(function(error, result) {
	if (error) {
		console.log("w3", "Debug error: " + error);
	} else {
		console.log("w3", "Debug: " + result.code);
	}
})

// endregion

// region transactions history

var history = [];

function trackHistory(from, to, skill, time) {
	var item = { "from" : from, "to" : to, "skill" : skill, "time" : time};
	console.log("w3", item);
	history.push(JSON.stringify(item));
	console.log("w3", "history size: " + history.length);
} 

function getHistory() {
	console.log(history);
	return "[" + history + "]";
}

function getNameByAccount(account) {
	return getKeyByValue(profiles, account);
}

// endregion

// region waiting queue 

var waitingQueue = [];

function getWaitingQueue() {
	console.log(transformQueueIntoJson());
	return transformQueueIntoJson();
}

function addToWaitingQueue(person, organisation, skill, time) {
	console.log("w3", "=====================");
	console.log("w3", "=====================");
	var item = { "person" : person, "skill" : skill, "time" : time, "mentored" : false};
	console.log("w3", "addToWaitingQueue");
	console.log("w3", item);
	waitingQueue.push(item);
	console.log("w3", "queue size: " + waitingQueue.length);
}

/**
 * conditions:
 * - one person -> one skill
 * - one person -> two skills
 * - one person -> skill (which is just completed) and the same person who ask for help again
 * 
 * solution:
 * - hold all data
 * - add boolean parameter as indicator of processed
 * - iterate over array to find righ tuple<person, skill>
 * - provide decorator whoch convert array of data into json format
 * */ 

function markedRequestAsProcessedInWaitingQueue(person, organisation, skill, time) {
	var size = waitingQueue.length;
	console.log("w3", "=====================");
	console.log("w3", "markedRequestAsProcessedInWaitingQueue");
	for (var idx = 0; idx < size; idx++) {
		console.log("w3", 
			"person: " + waitingQueue[idx].person + " " +
			"skill: " + waitingQueue[idx].skill + " " + 
			"mentored: " + waitingQueue[idx].mentored + " "
		);
		console.log("w3", 
			"person: " + person + " " +
			"skill: " + skill + " " 
		);
		if (waitingQueue[idx].person === person 
			&& waitingQueue[idx].skill === skill
			&& waitingQueue[idx].mentored === false) {
			
			console.log("w3", "waitingQueue[idx].mentored");
			waitingQueue[idx].mentored = true;
		}
	}
}

function transformQueueIntoJson() {
	var result = [];
	var size = waitingQueue.length;
	for (var idx = 0; idx < size; idx++) {
		result.push(JSON.stringify(waitingQueue[idx]));
	}
	return "[" + result + "]";
}

// endregion

// region transactions

var transactions = [];

function addTransaction(txHash, isMined) {
	console.log("w3", "addTransaction");
	var item = {};
	item[txHash] = isMined;
	transactions.push(item);
}

function updateTransaction(txHash, isMined) {
	var isProcessed = false;
	for (var idx = 0; idx < transactions.length; idx++) {
		for (var key in transactions[idx]) {
			if (txHash == key) {
				var item = {};
				item[txHash] = isMined;
				transactions[idx] = item;
				isProcessed = true;
				break;
			} 
		}
	}

	if (!isProcessed) {
		addTransaction(txHash, isMined);
	}
}

// endregion

// region users

function getUsers() {
	return dataset.users;
}

// endregion

// region helpers

function getAccountByName(searchKey) {
	var account;
	Object.keys(profiles).find(function(key) {
		if (key === searchKey) {
			account = profiles[key];
		}
	});
	return account;
}

function getItemByKey(data, searchKey) {
	return Object.keys(data).find(key => data[key] === searchKey);
}

function getKeyByValue(object, value) {
	return Object.keys(object).find(key => object[key] === value);
}

// endregion