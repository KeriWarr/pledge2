require('dotenv').config()

const { promisify } = require('util');
const express = require('express');
const bodyParser = require('body-parser');
const { OAuth2 } = require('oauth');
const querystring = require('querystring');
const R = require('ramda');

const splitwiseAPIURL = 'https://secure.splitwise.com/api/v3.0/';
const splitwiseGetGroupEndpoint = 'get_group/';
const splitwiseExpensesEndpoint = 'get_expenses/?limit=0';
const splitwiseExpenseEndpoint = 'get_expense/';
const splitwiseSetExpenseEndpoint = 'update_expense/';
const splitwiseCreateExpenseEndpoint = 'create_expense/';
const port = 3000;
const pledgeHeader = 'This is an auto-generated expense. Please do not modify it.';
let accessToken = '';

const oauth2 = new OAuth2(
  process.env.SPLITWISE_CONSUMER_KEY,
  process.env.SPLITWISE_CONSUMER_SECRET,
  'https://secure.splitwise.com/',
  null,
  'oauth/token',
  null,
);

const oAuthGetToken = promisify(oauth2.getOAuthAccessToken.bind(oauth2));
const oAuthGet = promisify(oauth2.get.bind(oauth2))
const oAuthRequest = promisify(oauth2._request.bind(oauth2)); // eslint-disable-line no-underscore-dangle
const oAuthPost = (url, postData) => oAuthRequest('POST', url, {
  'Content-Type': 'application/x-www-form-urlencoded',
  Authorization: oauth2.buildAuthHeader(accessToken),
}, querystring.stringify(postData), null);

const getGroup = () =>
  oAuthGet(`${splitwiseAPIURL}${splitwiseGetGroupEndpoint}${process.env.SPLITWISE_GROUP_ID}`, accessToken)
  .then(body => JSON.parse(body).group);
const getExpenses = () =>
  oAuthGet(`${splitwiseAPIURL}${splitwiseExpensesEndpoint}`, accessToken).then(body => JSON.parse(body).expenses);
const getUserMapping = () =>
  oAuthGet(`${splitwiseAPIURL}${splitwiseExpenseEndpoint}${process.env.SPLITWISE_USER_MAPPING_EXPENSE_ID}`, accessToken).then(body => R.apply(
    R.zipObj,
    R.transpose(JSON.parse(body).expense.details.split('\n').map(line => line.split('=')))));
const setUserMapping = (mapping) =>
  oAuthPost(
    `${splitwiseAPIURL}${splitwiseSetExpenseEndpoint}${process.env.SPLITWISE_USER_MAPPING_EXPENSE_ID}`, {
      details: R.toPairs(mapping).map(pair => pair.join('=')).join('\n')
    });
const createWager = ({ makerID, takerID, makerStake, takerStake, description, makerName }) =>
  oAuthPost(
    `${splitwiseAPIURL}${splitwiseCreateExpenseEndpoint}`, {
      payment: false,
      cost: makerStake + takerStake,
      description: description,
      group_id: process.env.SPLITWISE_GROUP_ID,
      details: `${pledgeHeader}\nCreated by ${makerName} at ${new Date().toISOString()}`,
      currency_code: 'PYG',
      users__0__user_id: process.env.SPLITWISE_SPECIAL_USER_ID,
      users__0__owed_share: makerStake + takerStake,
      users__1__user_id: makerID,
      users__1__paid_share: takerStake,
      users__2__user_id: takerID,
      users__2__paid_share: makerStake,
    }).then(console.log);

const formatExpense = expense => {
  const maker = expense.users[1];
  const taker = expense.users[2];
  const makerName = maker.user.first_name;
  const makerWager = parseFloat(taker.paid_share);
  const takerName = taker.user.first_name;
  const takerWager = parseFloat(maker.paid_share);
  const description = expense.description;
  return `${makerName} waged ${makerWager} against ${takerName}'s ${takerWager} that "${description}"`;
};

const handleRequest = (req, res) => {
  const respond = (() => {
    let responded = false;

    return (message) => {
      if (!responded) {
        responded = true;
        res.send(message);
      }
    };
  })();

  if (req.body.token !== process.env.SLACK_VALIDATION_TOKEN) {
    return;
  }
  if (req.body.team_id !== process.env.NOKAPPA_TEAM_ID) {
    return;
  }

  setTimeout(() => {
    respond('Sorry, splitwise is taking too long to respond.');
  }, 2500);

  const { text } = req.body;
  const command = text.split(' ')[0];
  const args = R.drop(1, text.split(' ')).join(' ');

  const printUsage = () =>
    respond('Usage:\n`help`: Prints this message.\n`register <your splitwise name or id>`: associate your slack profile with your splitwise account.');

  switch (command) {
    case 'help':
      printUsage();
      break;
    case 'register':
      if (args === '') {
        printUsage();
        break;
      }
      Promise.all([getGroup(), getUserMapping()]).then(([group, userMapping]) => {
        const member = R.find(member => (
          member.id == args ||
          member.first_name.toLowerCase() == args.toLowerCase() ||
          (member.first_name + ' ' + member.last_name).toLowerCase() == args.toLowerCase()), group.members);
        if (!member) {
          respond('Couldn\'t find that splitwise user.');
        } else {
          setUserMapping(R.assoc(req.body.user_id, member.id, userMapping)).then(() => {
            respond('Success!');
          }, () => { respond('Sorry, something went wrong.'); })
        }
      }, () => { respond('Sorry, something went wrong.'); });
      break;
    case 'cancel':
      break;
    case 'complete':
      break;
    case 'all':
      Promise.all([getGroup(), getExpenses()]).then(([group, expenses]) => {
        const pledgeExpenses = expenses.filter(expense => expense && expense.details &&  expense.details.startsWith(pledgeHeader))
        respond(pledgeExpenses.map(formatExpense).join('\n'));
      });
    case 'me':
      break;
    case 'show':
      break;
    default:
      Promise.all([getGroup(), getUserMapping()]).then(([group, mapping]) => {
        const match = text.match(/^<@(U[A-Z0-9]+)\|.*> (\d+(?:\.\d{2})?)#(\d+(?:\.\d{2})?) (.*)$/);
        if (!match) {
          respond('Sorry, that is not a valid command.');
          throw '';
        }
        const makerSlackID = req.body.user_id;
        const takerSlackID = match[1];
        const makerSWID = mapping[makerSlackID];
        const takerSWID = mapping[takerSlackID];
        const maker = R.find(member => member.id === parseInt(makerSWID,10), group.members);
        if (!makerSWID || ! takerSWID) {
          respond('Sorry, both users must be registered before making wagers.');
          throw '';
        }
        const makerStake = parseFloat(match[2]);
        const takerStake = parseFloat(match[3]);
        const description = match[4];
        return createWager({
          makerID: makerSWID,
          takerID: takerSWID,
          makerStake,
          takerStake,
          description,
          makerName: maker.first_name,
        });
      }).then(body => {
        console.log(body);
        respond("Success!")
      }).catch(body => {
        console.log(body);
        return;
      });

  }
};

oAuthGetToken('', { grant_type: 'client_credentials' }).then((token) => {
  accessToken = token;

  const app = express();
  app.use(bodyParser.urlencoded({ extended: false }));
  app.post('/', handleRequest);
  app.listen(port, () => {
    console.log(`Listening on port ${port}`);
  });
});
