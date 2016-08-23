var AWS = require('aws-sdk');
var Promise = require('bluebird');
var tcpp = require('tcp-ping');

AWS.config.update({region: 'us-east-1'});

const tableName = 'lambda-healthcheck-v1';
const tagName = 'tcp_healthcheck';
const maxMissed = 3;

var dynamodb = new AWS.DynamoDB();
var docClient = new AWS.DynamoDB.DocumentClient();
var autoscaling = new AWS.AutoScaling();


createTable(tableName) // create the table in DynamoDB if does not exsist
    .then(getInstances(tagName)) // pull all the instances by tag that need to be health checked and perform checks
    .catch(function (err) {
        console.log(err);
    });

/**
 *
 */
function getInstances() {
    var ec2 = new AWS.EC2();

    ec2.describeInstances( // return instances that match tag filter
        {
            Filters: [{
                Name: 'tag:'+tagName,
                Values: ['*']
            }] //TODO: add filter for VPC to limit to current VPC only
        }
    ).promise()
        .then(data => { // then step through instances and call healthcheck on each instance
            for (let reservation of data.Reservations) {
                for (let instance of reservation.Instances) {
                    checkInstance(instance);
                }
            }
        });
}

/**
 *
 */
function checkInstance(instance){
    var port = instance.Tags.find(tag => tag.Key=='tcp_healthcheck'); // port is set to value in tag
    var pingThenable = Promise.promisify(tcpp.ping); // promisfy the tcp-ping ping function
    pingThenable(
        {
            address: instance.PrivateIpAddress,
            port: port.Value,
            attempts: 1,
            timeaouts: 5000
        }
    ).then( // insert results into dynamodb
        data => putInstanceIntoDB(instance, data)
    ).then( // set EC2 unhealthy
        missedCount => setInstanceHealth(instance, missedCount)
    );
}


/**
 *
 */
function setInstanceHealth(instance, missedCount) {

    // if missed count is greater that the max then the instance is unhealthy
    var healthStatus = (missedCount > maxMissed)? 'Unhealthy': 'Healthy';

    var params = {
        InstanceId: instance.InstanceId,
        HealthStatus: healthStatus,
        ShouldRespectGracePeriod: true
    };
    console.log(instance.InstanceId +' is '+ healthStatus +' with a missed count of '+ missedCount);
    autoscaling.setInstanceHealth(params).promise().catch(reason => {console.log('ERROR '+ reason)}); // request a promise for error handling
}


/**
 *
 */
function putInstanceIntoDB(instance, results){

    return new Promise(function (fulfill, reject) {
        //TODO: Remove any old db instance entries

        var instance_id = {  //query parameters to find instance in dynamodb
                TableName: tableName,
                Key: {'ec2-id': instance.InstanceId}
            };


        docClient.get(instance_id).promise() // get instance from db
            .then(data => { // THEN
                var missedCount = 0;
                var pingReturned = (results.min != undefined); // true if ping returned

                if (data.Item != undefined) { // IF there is already an entry
                    missedCount = pingReturned ? 0 : data.Item.missed_count + 1; // IF ping returned set to 0 ELSE increment missed count by 1
                    let update_instance = {
                        TableName: tableName,
                        Key: {'ec2-id': instance.InstanceId},
                        UpdateExpression: "set missed_count=:m, last_seen=:l",
                        ExpressionAttributeValues: {
                            ":m": missedCount,
                            ":l": Date.now()
                        },
                        ReturnValues: "UPDATED_NEW"
                    };
                    if (missedCount != data.Item.missed_count) // only update if missed count changed
                        docClient.update(update_instance).promise(); // set promise to db UPDATE action

                } else if (!pingReturned) { // ELSE if no entry AND ping did not return add one with failed count of one
                    missedCount = 1;
                    console.log('Adding ID to table: ' + instance.InstanceId);
                    let add_instance = {
                        TableName: tableName,
                        Item: {
                            'ec2-id': instance.InstanceId,
                            'missed_count': missedCount,
                            'last_seen': Date.now()
                        }
                    };
                    docClient.put(add_instance).promise(); // set promise to db PUT action
                }
                fulfill(missedCount); // return the missed count in the promise
            });

      //  console.log('Instance not responding: ' + instance.InstanceId); //TODO: Add better logging outputs


    })
}

/**
 * Retrieve a DynamoDB table to store tcp ping results, create it if does not exist
 */
function createTable(tableName, readCapacity = 4, writeCapacity = 1) {

    return  dynamodb.listTables().promise() // get a list of tables
        .then(data => { // filter by tableName
            const exists = data.TableNames
                    .filter(name => {
                        return name === tableName;
                    })
                    .length > 0;
            if (exists) { // if it exists return
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
                    }
                };
                return dynamodb.createTable(params).promise();
            }
        });
}