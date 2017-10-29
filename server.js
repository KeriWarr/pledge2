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
const port = 3000;
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
  oAuthGet(`${splitwiseAPIURL}${splitwiseExpensesEndpoint}`, accessToken);
const getUserMapping = () =>
  oAuthGet(`${splitwiseAPIURL}${splitwiseExpenseEndpoint}${process.env.SPLITWISE_USER_MAPPING_EXPENSE_ID}`, accessToken).then(body => R.apply(
    R.zipObj,
    R.reverse(R.transpose(JSON.parse(body).expense.details.split('\n').map(line => line.split('='))))));
const setUserMapping = (mapping) =>
    oAuthPost(
      `${splitwiseAPIURL}${splitwiseSetExpenseEndpoint}${process.env.SPLITWISE_USER_MAPPING_EXPENSE_ID}`, {
        details: R.toPairs(mapping).map(pair => pair.join('=')).join('\n')
      })

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

  switch (command) {
    case 'help':
      respond('Usage:\n`help`: Prints this message.\n`register <your splitwise name or id>`: associate your slack profile with your splitwise account.');
      break;
    case 'register':
      Promise.all([getGroup(), getUserMapping()]).then(([group, userMapping]) => {
        const member = R.find(member => (
          member.id == args ||
          member.first_name.toLowerCase == args.toLowerCase() ||
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
    default:
      respond('Sorry, that is not a valid command.');
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
