
var AWS = require('aws-sdk');
var tcpp = require('tcp-ping');

AWS.config.update({region: 'us-east-1'});

const tableName = 'lambda-healthcheck-v1';


var dynamodb = new AWS.DynamoDB();

getInstances()
getTable(tableName);



tcpp.probe('www.google.com', 80, function(err, data) {
    console.log(data);
});



function getInstances() {
    var ec2 = new AWS.EC2();

    var test = ec2.describeInstances(
        {Filters: [{
                    Name: 'tag:tcp_healthcheck',
                    Values: [
                        'true',
                    ]
        }]}
    ).promise()
        .then(data => {
            console.log('Success');
            console.log(data[0].privateIpAddress);
        })
        .catch(function(err) {
        console.log(err);
    });
}

/* Retrieve a DynamoDB table to store tcp ping results, create it if does not exsist */
function getTable(tableName, readCapacity=4, writeCapacity=1) {

    const tablePromise = dynamodb.listTables({}) // get list of tables
    .promise()
    .then(data => { // filter by tableName
        const exists = data.TableNames
            .filter(name => {
                return name === tableName;
            })
            .length > 0;
        if (exists) { // if it exsists return
            return Promise.resolve();
        }
        else { // else create a new table with single attribute for hash key, other values will be added as JSON
            var params = {
                TableName: tableName,
                AttributeDefinitions: [{ AttributeName: 'ec2-id', AttributeType: 'S'}],
                KeySchema: [{ AttributeName: 'ec2-id', KeyType: 'HASH'}],
                ProvisionedThroughput: {
                    ReadCapacityUnits: readCapacity,
                    WriteCapacityUnits: writeCapacity
                },
            };
            return dynamodb.createTable(params).promise();
        }
    });

}

/*            { AttributeName: 'name', AttributeType: 'S'},
            { AttributeName: 'ip', AttributeType: 'S'},
            { AttributeName: 'ports', AttributeType: 'S'},
            { AttributeName: 'expected-response', AttributeType: 'S'},
            { AttributeName: 'missed-count', AttributeType: 'S'},
            { AttributeName: 'last-seen', AttributeType: 'S'}*/