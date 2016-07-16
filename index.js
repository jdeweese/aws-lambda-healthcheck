var AWS = require('aws-sdk');
var tcpp = require('tcp-ping');

AWS.config.update({region: 'us-east-1'});

const tableName = 'lambda-healthcheck-v1';


var dynamodb = new AWS.DynamoDB();

getTable(tableName).then(
    getInstances()
)


tcpp.probe('www.google.com', 80, function (err, data) {
    console.log(data);
});


function getInstances() {
    return new Promise( (fulfill, reject) => {
        var ec2 = new AWS.EC2();

        var test = ec2.describeInstances(
            {
                Filters: [{
                    Name: 'tag:tcp_healthcheck',
                    Values: ['*']
                }] //TODO: add filter for VPC to limit to current VPC only
            }
        ).promise()
            .then(data => {
                for (let reservation of data.Reservations) {
                    for (let instance of reservation.Instances) {
                        healthcheckInstance(instance);
                    }
                }
            })
            .catch(function (err) {
                console.log(err);
            })
    });
}

function healthcheckInstance(instance){
    
    port = instance.Tags.find(tag => tag.Key=='tcp_healthcheck');

    tcpp.ping(
        {
            address: instance.PrivateIpAddress,
            port: port.Value,
            attempts: 4,
            timeaouts: 5000
        }
    );

    console.log(instance.PrivateIpAddress);

}



/* Retrieve a DynamoDB table to store tcp ping results, create it if does not exsist */
function getTable(tableName, readCapacity = 4, writeCapacity = 1) {

    return tablePromise = dynamodb.listTables({}) // get list of tables
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
                    AttributeDefinitions: [{AttributeName: 'ec2-id', AttributeType: 'S'}],
                    KeySchema: [{AttributeName: 'ec2-id', KeyType: 'HASH'}],
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