var AWS = require('aws-sdk');
var Promise = require('bluebird');
var tcpp = require('tcp-ping');

AWS.config.update({region: 'us-east-1'});

const tableName = 'lambda-healthcheck-v1';
const tagName = 'tcp_healthcheck';

var dynamodb = new AWS.DynamoDB();
var docClient = new AWS.DynamoDB.DocumentClient();

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

    var test = ec2.describeInstances( // return instances that match tag filter
        {
            Filters: [{
                Name: 'tag:'+tagName,
                Values: ['*']
            }] //TODO: add filter for VPC to limit to current VPC only
        }
    ).promise()
        .then(data => { // then step through instances and call healthcheck on each instance
            for (reservation of data.Reservations) {
                for (instance of reservation.Instances) {
                    checkInstance(instance);
                }
            }
        });
}

/**
 *
 */
function checkInstance(instance){
    port = instance.Tags.find(tag => tag.Key=='tcp_healthcheck'); // port is set to value in tag
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
        () => setInstanceHealth(instance, 0)
    );
}


/**
 *
 */
function setInstanceHealth(instance, health) {
    const healthStatus = ['Unhealth','Healthy'];
    var params = {
        InstanceId: instanceId,
        HealthStatus: healthStatus[health],
        ShouldRespectGracePeriod: false
    };

    ASG_AWS.setInstanceHealth(params, function (err, data) { //TODO: Finish here
        if (err) {
            cb(err, null);
        } else {
            cb(null, data);
        }
    })
}



/**
 *
 */
function putInstanceIntoDB(instance, results){

    //TODO: Remove any old db instance entries

    var DbPromise = null;
    if(results.min == undefined){ // IF ping failed
        let instance_id = { // GET instance from db
            TableName:tableName,
            Key:{'ec2-id': instance.InstanceId}
        };
        docClient.get(instance_id).promise()
            .then(data => { // THEN
                if(data.Item != undefined){ // IF there is already an entry for the instance add one to failed count
                    let update_instance = {
                        TableName:tableName,
                        Key:{'ec2-id': instance.InstanceId},
                        UpdateExpression: "set missed_count=:m, last_seen=:l",
                        ExpressionAttributeValues:{
                            ":m": data.Item.missed_count + 1, // increment missed count by 1
                            ":l": Date.now()
                        },
                        ReturnValues:"UPDATED_NEW"
                    };
                    DbPromise = docClient.update(update_instance).promise(); // set promise to db UPDATE action

                } else{ // ELSE if no entry add one with failed count of one
                    console.log('Adding ID to table: ' + instance.InstanceId);
                    let add_instance = {
                        TableName:tableName,
                        Item: {
                            'ec2-id': instance.InstanceId,
                            'missed_count': 1,
                            'last_seen': Date.now()
                        }
                    }
                    DbPromise =  docClient.put(add_instance).promise(); // set promise to db PUT action
                }
            });
        console.log('Instance not responding: ' + instance.InstanceId,  );

    } else {
        console.log('Pinged instance successfully: ' + instance.InstanceId);

    }

    dbPromise = Promise.resolve(); // return a empty promise for successful pings, no database action required

    return DbPromise;

}

/**
 *
 */
/* Retrieve a DynamoDB table to store tcp ping results, create it if does not exsist */
function createTable(tableName, readCapacity = 4, writeCapacity = 1) {

    return tablePromise = dynamodb.listTables({}).promise() // get a list of tables
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